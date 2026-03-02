# diameter-wasm-viewer

浏览器端（WASM）解析 pcap/pcapng 中 Diameter(TCP) 报文，默认过滤 cmd code=272，支持树形查看与 Excel 导出。

## 目录

- `wasm/` Rust + wasm-bindgen
- `web/` 单页前端

## 构建

```bash
cd wasm
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
wasm-pack build --target web --out-dir ../wasm/pkg
```

## 运行

```bash
cd ..
python -m http.server 8000
```

打开：`http://localhost:8000/web/`
