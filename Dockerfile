# ===== 阶段 1：builder（装依赖、做准备）=====
FROM node:18-alpine AS builder

WORKDIR /app

# 先拷 package.json，利用 Docker 缓存层
COPY package*.json ./

# tsx / tsc / devDependencies 都需要，所以不使用 --only=production
RUN npm ci

# 拷贝源代码
COPY . .


# ===== 阶段 2：runtime（只留运行时所需）=====
FROM node:18-alpine AS runtime

WORKDIR /app

# 从 builder 拷贝 node_modules（已包含 tsx 等运行时依赖）
COPY --from=builder /app/node_modules ./node_modules

# 运行时需要的源码和配置
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/src ./src
COPY --from=builder /app/scripts ./scripts

# 应用监听端口
EXPOSE 3001

# 直接用 tsx 跑 TypeScript 入口（项目不做 npm run build）
CMD ["npx", "tsx", "src/index.ts"]
