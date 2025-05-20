import fs from 'fs-extra';
import path from 'path';
import tar from 'tar-stream';
import crypto from 'crypto';
import zlib from 'zlib';

function isProbablyGzip(buffer: Buffer): boolean {
  return buffer[0] === 0x1f && buffer[1] === 0x8b
}

export async function saveAsDockerTar(
  image: {
    manifest: any
    config: Buffer
    layers: Buffer[]
  },
  outputPath: string,
  meta: { repository: string; tag: string }
) {
  const pack = tar.pack()
  const tarWriteStream = fs.createWriteStream(outputPath)
  pack.pipe(tarWriteStream)

  const layers: string[] = []

  for (let i = 0; i < image.layers.length; i++) {
    const layer = image.layers[i]
    const digest = crypto.createHash('sha256').update(layer).digest('hex')
    const layerDir = `${digest.substring(0, 12)}`
    layers.push(`${layerDir}/layer.tar`)

    pack.entry({ name: `${layerDir}/VERSION` }, '1.0')
    pack.entry({ name: `${layerDir}/json` }, JSON.stringify({ id: `layer-${i}` }))
    pack.entry({ name: `${layerDir}/layer.tar` }, layer)
  }

  const configDigest = crypto.createHash('sha256').update(image.config).digest('hex')
  const configFilename = `${configDigest}.json`
  pack.entry({ name: configFilename }, image.config)

  const manifestJson = [
    {
      Config: configFilename,
      RepoTags: [`${meta.repository}:${meta.tag}`],
      Layers: layers,
    },
  ]
  pack.entry({ name: 'manifest.json' }, JSON.stringify(manifestJson, null, 2))

  const repositoriesJson = {
    [meta.repository]: {
      [meta.tag]: layers[layers.length - 1]?.replace('/layer.tar', '') || '',
    },
  }
  pack.entry({ name: 'repositories' }, JSON.stringify(repositoriesJson, null, 2))

  pack.finalize()
}

export async function saveAsOCIImageLayout(
  image: {
    manifest: any
    config: Buffer
    layers: Buffer[]
  },
  outputDir: string,
  meta: { repository: string; tag: string },
  useGzip?: boolean
) {
  await fs.ensureDir(outputDir)
  await fs.writeJson(path.join(outputDir, 'oci-layout'), {
    imageLayoutVersion: '1.0.0',
  })

  const blobsDir = path.join(outputDir, 'blobs/sha256')
  await fs.ensureDir(blobsDir)

  const writeBlob = async (data: Buffer): Promise<string> => {
    const digest = crypto.createHash('sha256').update(data).digest('hex')
    await fs.writeFile(path.join(blobsDir, digest), data)
    return digest
  }

  const configDigest = await writeBlob(image.config)
  // const layerDigests = await Promise.all(image.layers.map(writeBlob))
  const layerDigests: string[] = []
  const outputLayers: Buffer[] = []
  const mediaTypes: string[] = []

  for (const layer of image.layers) {
    let data: Buffer
    let mediaType: string

    if (useGzip === undefined) {
      const shouldGzip = !isProbablyGzip(layer)
      data = shouldGzip ? zlib.gzipSync(layer) : layer
      mediaType = shouldGzip
        ? 'application/vnd.oci.image.layer.v1.tar+gzip'
        : 'application/vnd.oci.image.layer.v1.tar'
    } else {
      data = useGzip ? zlib.gzipSync(layer) : layer
      mediaType = useGzip
        ? 'application/vnd.oci.image.layer.v1.tar+gzip'
        : 'application/vnd.oci.image.layer.v1.tar'
    }

    outputLayers.push(data)
    mediaTypes.push(mediaType)
    const digest = await writeBlob(data)
    layerDigests.push(digest)
  }

  const manifest = {
    schemaVersion: 2,
    config: {
      mediaType: 'application/vnd.oci.image.config.v1+json',
      digest: `sha256:${configDigest}`,
      size: image.config.length,
    },
    layers: layerDigests.map((digest, i) => ({
      // mediaType: 'application/vnd.oci.image.layer.v1.tar',
      mediaType: mediaTypes[i],
      digest: `sha256:${digest}`,
      size: outputLayers[i].length,
      // size: image.layers[i].length,
    })),
  }

  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2))
  const manifestDigest = await writeBlob(manifestBuf)

  const index = {
    schemaVersion: 2,
    manifests: [
      {
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        digest: `sha256:${manifestDigest}`,
        size: manifestBuf.length,
        annotations: {
          'org.opencontainers.image.ref.name': `${meta.tag}`,
        },
      },
    ],
  }
  await fs.writeJson(path.join(outputDir, 'index.json'), index, { spaces: 2 })
}

export async function saveAsOCIImageLayoutWithgzip(
  image: {
    manifest: any
    config: Buffer
    layers: Buffer[]
  },
  outputDir: string,
  meta: { repository: string; tag: string }
) {
  await fs.ensureDir(outputDir)
  await fs.writeJson(path.join(outputDir, 'oci-layout'), {
    imageLayoutVersion: '1.0.0',
  })

  const blobsDir = path.join(outputDir, 'blobs/sha256')
  await fs.ensureDir(blobsDir)

  const writeBlob = async (data: Buffer): Promise<string> => {
    const digest = crypto.createHash('sha256').update(data).digest('hex')
    await fs.writeFile(path.join(blobsDir, digest), data)
    return digest
  }

  const configDigest = await writeBlob(image.config)
  const layerDigests: string[] = []
  const compressedLayers: Buffer[] = []

  for (const layer of image.layers) {
    const compressed = zlib.gzipSync(layer)
    compressedLayers.push(compressed)
    const digest = await writeBlob(compressed)
    layerDigests.push(digest)
  }

  const manifest = {
    schemaVersion: 2,
    config: {
      mediaType: 'application/vnd.oci.image.config.v1+json',
      digest: `sha256:${configDigest}`,
      size: image.config.length,
    },
    layers: layerDigests.map((digest, i) => ({
      mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
      digest: `sha256:${digest}`,
      size: compressedLayers[i].length,
    })),
  }

  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2))
  const manifestDigest = await writeBlob(manifestBuf)

  const index = {
    schemaVersion: 2,
    manifests: [
      {
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        digest: `sha256:${manifestDigest}`,
        size: manifestBuf.length,
        annotations: {
          'org.opencontainers.image.ref.name': `${meta.tag}`,
        },
      },
    ],
  }
  await fs.writeJson(path.join(outputDir, 'index.json'), index, { spaces: 2 })
}

// 整合流程範例
export async function pullAndSaveAll(
  client: any,
  repository: string,
  tag: string,
  dockerTarPath: string,
  ociDir: string,
  ociGzipDir: string
) {
  const image = await client.pullImage(repository, tag)
  await saveAsDockerTar(image, dockerTarPath, { repository, tag })
  await saveAsOCIImageLayout(image, ociDir, { repository, tag }, false)
  await saveAsOCIImageLayout(image, ociGzipDir, { repository, tag }, true)
}
