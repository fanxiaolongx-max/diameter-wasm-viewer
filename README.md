# diameter-wasm-viewer

浏览器端（WASM）解析 pcap/pcapng 中 Diameter(TCP) 报文，默认过滤 cmd code=272，支持树形查看与 Excel 导出。

新增：后端解析 MVP（tshark 驱动）+ Web 包浏览页面。

## 目录

- `wasm/` Rust + wasm-bindgen
- `web/` 单页前端（`index.html` 为原 WASM 版，`backend.html` 为后端版）
- `server/` Node.js 后端 API

## 构建 WASM（原前端）

```bash
cd wasm
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
wasm-pack build --target web --out-dir ../wasm/pkg
```

## 运行（原 WASM 前端）

```bash
cd ..
python -m http.server 8000
```

打开：`http://localhost:8000/web/`

## 运行后端 MVP

1) 安装 tshark（必须）

```bash
sudo apt install tshark
```

2) 安装并启动 Node 后端

```bash
cd server
npm install
npm run start
```

默认监听：`http://localhost:3001`

### 后端 API

- `POST /api/parse`：multipart 上传（字段 `file`，可选 `port`）
- `GET /api/sessions/:id/summary`
- `GET /api/sessions/:id/packets?offset=&limit=&filter=`
- `GET /api/sessions/:id/packet/:index`

## 运行后端浏览页面

在项目根目录另开一个静态文件服务：

```bash
python -m http.server 8000
```

打开：`http://localhost:8000/web/backend.html`

页面默认请求 `http://localhost:3001`，可在页面顶部修改 API Base。
