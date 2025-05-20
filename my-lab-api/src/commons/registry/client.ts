import axios, { AxiosInstance } from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import { request } from 'undici';
import { Readable } from 'stream';
import { pipeline } from 'stream';
import { promisify } from 'util';
import PQueue from 'p-queue';
const streamPipeline = promisify(pipeline)

type DockerAuthEntry = {
  auth?: string
}

export interface RegistryClientOptions {
  baseUrl: string
  username?: string
  password?: string
  axiosInstance?: AxiosInstance
  autoRedirect?: boolean
  registryProxyMap?: Record<string, string>
  blobProxyMap?: Record<string, string> 
  maxConcurrency?: number
  memoryThresholdBytes?: number
}

function loadDockerConfig(): Record<string, any> {
  try {
    const configPath = path.join(os.homedir(), '.docker', 'config.json')
    const content = fs.readFileSync(configPath, 'utf-8')
    return JSON.parse(content)
  } catch (err) {
    return {}
  }
}

function getAuthFromDockerConfig(registry: string): string | undefined {
  const config = loadDockerConfig()
  const auths = config.auths as Record<string, DockerAuthEntry>
  const authEntry = Object.entries(auths).find(([key]) => {
    return registry.includes(key) || key.includes(registry)
  })

  if (!authEntry) return undefined

  const authBase64 = authEntry[1]?.auth
  if (authBase64) {
    return `Basic ${authBase64}`
  }

  return undefined
}

export class ContainerRegistryClient {
  private readonly axios: AxiosInstance
  private readonly autoRedirect: boolean
  private readonly queue: PQueue
  private readonly memoryThreshold: number

  constructor(private readonly options: RegistryClientOptions) {
    this.autoRedirect = options.autoRedirect !== undefined ? options.autoRedirect : true
    this.memoryThreshold = options.memoryThresholdBytes ?? 3 * 1024 * 1024 * 1024 // 3GB default

    const headers: Record<string, string> = {
      Accept: 'application/vnd.docker.distribution.manifest.v2+json',
    }

    if (options.username && options.password) {
      const token = Buffer.from(`${options.username}:${options.password}`).toString('base64')
      headers['Authorization'] = `Basic ${token}`
    } else {
      const dockerToken = getAuthFromDockerConfig(options.baseUrl)
      if (dockerToken) {
        headers['Authorization'] = dockerToken
      }
    }

    this.axios = options.axiosInstance ?? axios.create({
      baseURL: options.baseUrl,
      headers,
    })

    this.queue = new PQueue({
      concurrency: options.maxConcurrency ?? 5,
    });
  }

  private async waitForMemoryAvailability() {
    while (os.freemem() < this.memoryThreshold) {
      console.warn('Memory low, delaying task...');
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  async getImageManifest(repository: string, tag: string) {
    const url = `/v2/${repository}/manifests/${tag}`
    const response = await this.axios.get(url)
    return response.data
  }

  async pullBlobAsBuffer(repository: string, digest: string): Promise<{ buffer: Buffer; size: number; digest: string }> {
    await this.waitForMemoryAvailability();

    const url = `/v2/${repository}/blobs/${digest}`;
    const response = await this.axios.get(url, {
      responseType: 'arraybuffer',
      maxRedirects: 0,
      validateStatus: status => [200, 302, 307].includes(status),
    });

    if ([302, 307].includes(response.status)) {
      const location = response.headers['location'];
      if (!location) throw new Error('Missing redirect location');
      const redirected = await axios.get(location, { responseType: 'arraybuffer' });
      return {
        buffer: Buffer.from(redirected.data),
        digest,
        size: parseInt(redirected.headers['content-length'] || '0', 10),
      };
    }

    return {
      buffer: Buffer.from(response.data),
      digest,
      size: parseInt(response.headers['content-length'] || '0', 10),
    };
  }

  async pullBlobAsStream(repository: string, digest: string): Promise<{ stream: Readable; size: number; digest: string }> {
    await this.waitForMemoryAvailability();

    const url = `/v2/${repository}/blobs/${digest}`;
    const response = await this.axios.get(url, {
      responseType: 'stream',
      maxRedirects: 0,
      validateStatus: status => [200, 302, 307].includes(status),
    });

    if ([302, 307].includes(response.status)) {
      const location = response.headers['location'];
      if (!location) throw new Error('Missing redirect location');
      const redirected = await axios.get(location, { responseType: 'stream' });
      return {
        stream: redirected.data,
        digest,
        size: parseInt(redirected.headers['content-length'] || '0', 10),
      };
    }

    return {
      stream: response.data,
      digest,
      size: parseInt(response.headers['content-length'] || '0', 10),
    };
  }

  async syncImageWithBuffer(sourceRepo: string, sourceTag: string, destRepo: string, destTag: string) {
    const manifest = await this.getImageManifest(sourceRepo, sourceTag);
    const configDigest = manifest.config.digest;

    // Pull and push config
    const { stream: configStream, size: configSize } = await this.pullBlobAsStream(sourceRepo, configDigest);
    await this.pushBlobStream(destRepo, configDigest, configStream, configSize);

    // Pull and push each layer one-by-one
    for (const layer of manifest.layers) {
      const { stream: layerStream, size: layerSize } = await this.pullBlobAsStream(sourceRepo, layer.digest);
      await this.pushBlobStream(destRepo, layer.digest, layerStream, layerSize);
    }

    // Rebuild manifest using original digests and sizes
    const newManifest = {
      schemaVersion: 2,
      mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
      config: {
        mediaType: manifest.config.mediaType,
        size: configSize,
        digest: configDigest,
      },
      layers: manifest.layers.map(layer => ({
        mediaType: layer.mediaType,
        size: layer.size,
        digest: layer.digest,
      })),
    };

    await this.axios.put(`/v2/${destRepo}/manifests/${destTag}`, newManifest, {
      headers: {
        'Content-Type': 'application/vnd.docker.distribution.manifest.v2+json',
      },
    });
  }

  async streamBlob(sourceRepository: string, digest: string, destinationRepository: string): Promise<void> {
    const uploadUrl = await this.startBlobUpload(destinationRepository);
    const { stream, size } = await this.pullBlobAsStream(sourceRepository, digest);
    await this.pushBlobStream(uploadUrl, stream, digest, size);
  }

  async pullBlob(repository: string, digest: string): Promise<{ data: Buffer; isGzip: boolean }> {
    let response
    if (this.autoRedirect) {
      response = await this.axios.get(`/v2/${repository}/blobs/${digest}`, {
        responseType: 'arraybuffer',
        maxRedirects: 5,
      })
      // return Buffer.from(response.data)
    } else {
      response = await this.axios.get(`/v2/${repository}/blobs/${digest}`, {
        responseType: 'arraybuffer',
        maxRedirects: 0,
        validateStatus: (status) => status === 200 || status === 302 || status === 307,
      })

      if (response.status === 302 || response.status === 307) {
        const location = response.headers['location']
        if (!location) throw new Error('Redirect response missing Location header')
  
        const redirectedResponse = await axios.get(location, {
          responseType: 'arraybuffer',
          maxRedirects: 5,
        })
        response = redirectedResponse
      } else if (response.status !== 200) {
        throw new Error(`Unexpected status code ${response.status} when pulling blob`)
      } 
    }

    const buffer = Buffer.from(response.data)
    const gzipByMagic = buffer[0] === 0x1f && buffer[1] === 0x8b
    const encodingHeader = response.headers['content-encoding'] || ''
    const typeHeader = response.headers['content-type'] || ''
    const gzipByHeader =
        encodingHeader.toLowerCase().includes('gzip') ||
        typeHeader.toLowerCase().includes('gzip')
    const isGzip = gzipByMagic || gzipByHeader
    // const isGzip = buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b
    return { data: buffer, isGzip }

  }

  async pullBlobWithRedirect(url: string, headers: Record<string, string> = {}) {
    try {
      const response = await this.axios.get(url, {
        responseType: 'arraybuffer',
        headers,
        maxRedirects: 0,
        validateStatus: (status) => status === 200 || status === 307,
      })
  
      if (response.status === 200) {
        return response
      } else if (response.status === 307) {
        const redirectUrl = response.headers['location']
        if (!redirectUrl) throw new Error('Redirect location missing')
        const redirectedResp = await axios.get(redirectUrl, {
          responseType: 'arraybuffer',
        })
        return redirectedResp
      } else {
        throw new Error(`Unexpected status code ${response.status}`)
      }
    } catch (err) {
      throw err
    }
  }

  async pullImage(repository: string, tag: string) {
    const manifest = await this.getImageManifest(repository, tag)
    const layers = manifest.layers
    const config = manifest.config

    // 取得 config blob
    // const configBlob = await this.pullBlobWithRedirect(`/v2/${repository}/blobs/${config.digest}`, {
    //   responseType: 'arraybuffer',
    // })
    const configBlob = await this.pullBlob(repository, config.digest)

    // 取得所有 layer blobs
    // const layerBlobs = await Promise.all(
    //   layers.map((layer: any) =>
    //     this.pullBlobWithRedirect(`/v2/${repository}/blobs/${layer.digest}`, {
    //       responseType: 'arraybuffer',
    //     })
    //   )
    // )
    const layerBlobs = await Promise.all(
      layers.map((layer: any) => this.pullBlob(repository, layer.digest))
    )

    // 判斷 gzip
    // const layersWithGzip = layerBlobs.map((resp) => {
    //   const buf = Buffer.from(resp.data)
    //   // const gzip = buf[0] === 0x1f && buf[1] === 0x8b
    //   const gzipByMagic = buf[0] === 0x1f && buf[1] === 0x8b
    //   const encodingHeader = resp.headers['content-encoding'] || ''
    //   const typeHeader = resp.headers['content-type'] || ''
    //   const gzipByHeader =
    //     encodingHeader.toLowerCase().includes('gzip') ||
    //     typeHeader.toLowerCase().includes('gzip')
    //   const isGzip = gzipByMagic || gzipByHeader
    //   return {
    //     data: buf,
    //     // isGzip: gzip,
    //     isGzip,
    //   }
    // })

    return {
      manifest,
      config: configBlob.data,
      // layers: layerBlobs.map((resp) => resp.data),
      // layers: layersWithGzip,
      // new 
      configIsGzip: configBlob.isGzip, // config 通常不會 gzip，但留著可檢查
      layers: layerBlobs.map(({ data, isGzip }) => ({ data, isGzip })),
    }
  }

  async startBlobUpload(repository: string): Promise<string> {
    const response = await this.axios.post(`/v2/${repository}/blobs/uploads/`, null, {
      headers: { 'Content-Length': '0' },
      maxRedirects: 0,
      validateStatus: status => status === 202,
    });
    return response.data.location || response.headers['location'];
  }

  // async pushBlobStream(uploadUrl: string, stream: Readable, digest: string, size: number): Promise<void> {
  async pushBlobStream(repository: string, digest: string, stream: Readable, size: number): Promise<void> {
    await this.waitForMemoryAvailability();

    const uploadUrl = await this.startBlobUpload(repository);    
    const finalUrl = `${uploadUrl}${uploadUrl.includes('?') ? '&' : '?'}digest=${digest}`;
    const { statusCode } = await request(finalUrl, {
      method: 'PUT',
      body: stream,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': size.toString(),
      }
    });

    if (statusCode !== 201) {
      throw new Error(`Failed to push blob: status ${statusCode}`);
    }
  }

  // async pushImage(repository: string, tag: string, manifest: any, config: Buffer, layers: Buffer[]) {
  async pushImage(repository: string, tag: string, manifest: any, config: Buffer, layers: { data: Buffer; isGzip: boolean }[]) {  
    // Push config blob
    const configDigest = `sha256:${this.sha256(config)}`
    await this.uploadBlob(repository, config, configDigest)

    // Push layers
    const layerDigests: string[] = []
    for (const layer of layers) {
      let dataToUpload = layer.data
      if (!layer.isGzip) {
        dataToUpload = zlib.gzipSync(layer.data)
      }
      const digest = `sha256:${this.sha256(dataToUpload)}`
      await this.uploadBlob(repository, dataToUpload, digest)
      // const digest = `sha256:${this.sha256(layer)}`
      // await this.uploadBlob(repository, layer, digest)
      layerDigests.push(digest)
    }

    // Construct and push manifest
    const imageManifest = {
      schemaVersion: 2,
      mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
      config: {
        mediaType: 'application/vnd.docker.container.image.v1+json',
        size: config.length,
        digest: configDigest,
      },
      layers: layerDigests.map((digest, idx) => ({
        mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip',
        // size: layers[idx].length,
        size: layers[idx].data.length,
        digest,
      })),
    }

    await this.axios.put(`/v2/${repository}/manifests/${tag}`, imageManifest, {
      headers: {
        'Content-Type': 'application/vnd.docker.distribution.manifest.v2+json',
      },
    })
  }

  async tagImage(repository: string, sourceTag: string, targetTag: string) {
    const manifest = await this.getImageManifest(repository, sourceTag)
    await this.axios.put(`/v2/${repository}/manifests/${targetTag}`, manifest, {
      headers: {
        'Content-Type': 'application/vnd.docker.distribution.manifest.v2+json',
      },
    })
  }

  private async uploadBlob(repository: string, blob: Buffer, digest: string) {
    const { data: { location } } = await this.axios.post(`/v2/${repository}/blobs/uploads/`, null, {
      headers: { 'Content-Length': '0' },
      maxRedirects: 0,
      validateStatus: status => status === 202,
    })

    await this.axios.put(`${location}&digest=${digest}`, blob, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': blob.length.toString(),
      },
      maxRedirects: 0,
    })
  }

  private sha256(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex')
  }

  async streamBlobchunk(
    sourceRepository: string,
    digest: string,
    destinationRepository: string
  ) {
    // Step 1: Start a blob upload
    const { data: { location } } = await this.axios.post(
      `/v2/${destinationRepository}/blobs/uploads/`,
      null,
      {
        headers: { 'Content-Length': '0' },
        maxRedirects: 0,
        validateStatus: status => status === 202,
      }
    )
  
    // Step 2: Pull blob stream (support redirect)
    const blobUrl = `/v2/${sourceRepository}/blobs/${digest}`
    const initialResponse = await this.axios.get(blobUrl, {
      responseType: 'stream',
      maxRedirects: 0,
      validateStatus: status => [200, 302, 307].includes(status),
    })
  
    let blobStream: NodeJS.ReadableStream
    if ([302, 307].includes(initialResponse.status)) {
      const redirectLocation = initialResponse.headers['location']
      if (!redirectLocation) throw new Error('Missing redirect location for blob pull')
      const redirected = await axios.get(redirectLocation, { responseType: 'stream' })
      blobStream = redirected.data
    } else {
      blobStream = initialResponse.data
    }
  
    // Step 3: Pipe blob stream to target registry using PUT
    const uploadUrl = `${location}&digest=${digest}`
    const putResponse = await this.axios.put(uploadUrl, blobStream, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Transfer-Encoding': 'chunked',
      },
      maxRedirects: 0,
      validateStatus: status => status === 201,
    })
  
    return putResponse.status === 201
  }
}
