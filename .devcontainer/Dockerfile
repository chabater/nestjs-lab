FROM node:20

# 安裝 bash 和其他 dev 工具（可選）
RUN apt-get update && apt-get install -y curl git vim && rm -rf /var/lib/apt/lists/*

# 建立工作目錄
WORKDIR /workspace

# 預設不要啟動任何服務
CMD [ "sleep", "infinity" ]
