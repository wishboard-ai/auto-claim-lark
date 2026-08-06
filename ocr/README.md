# 本地 PaddleOCR 发票识别服务

全本地、零 API 成本的发票识别后端，适合低配 / 无 GPU 机器（如 8GB Intel iMac）。
Node 主服务通过 `OCR_PROVIDER=paddle` 以本地 HTTP 调用它。

## 组成

- `ocr_service.py`：FastAPI 服务。`POST /recognize` 接收图片二进制 → PaddleOCR 识别文字 → `extract.structure` 规则抽取 → 返回统一 JSON。
- `extract.py`：纯规则的票种分类与字段抽取（仅依赖标准库，便于单测/调参）。
- `requirements.txt` / `start-ocr.sh`：依赖与一键启动。

返回 JSON 字段与 Node 端 `RecognizedInvoice` 对齐：
`type`（vat/train/taxi/unknown）、`amount`、`date`、`sellerName`、`buyerName`、`invoiceNo`、`taxAmount`、`summary`、`raw_text`（OCR 原文，便于调参）。

## 启动（macOS / Linux）

```bash
cd ocr
chmod +x start-ocr.sh
./start-ocr.sh          # 首次会建 venv、装依赖、下载 OCR 模型（较慢）
# 服务地址： http://127.0.0.1:8000   健康检查： curl http://127.0.0.1:8000/health
```

> Python 支持 3.8–3.12，推荐 **3.12**（paddlepaddle 2.6 上限为 3.12，尚不支持 3.13）。
> `start-ocr.sh` 会自动优先选用 3.12 → 3.11 → 3.10；也可用 `PYTHON=python3.12 ./start-ocr.sh` 指定。

自测（可选）：
```bash
curl -X POST --data-binary @/path/to/invoice.jpg \
     -H "Content-Type: image/jpeg" http://127.0.0.1:8000/recognize
```

## 让主服务使用它

在项目根目录 `.env` 设置：
```
OCR_PROVIDER=paddle
OCR_BASE_URL=http://localhost:8000
# openai 相关的 OCR_MODEL/OCR_API_KEY 在 paddle 模式下会被忽略
```
然后正常启动主服务（`./start.sh` 或 `npm start`）。识别请求会走本地 PaddleOCR。

## 准确率与调参

字段抽取是基于 OCR 文本的**规则匹配**（正则+关键字），比多模态大模型更「脆」，
不同版式可能抽错。遇到抽取不准时：

1. 看 Node 日志的 `PaddleOCR 返回：...` 或直接看返回里的 `raw_text`，确认 OCR 文本；
2. 到 `extract.py` 里对应票种的 `extract_vat / extract_train / extract_taxi`
   或分类关键字 `TAXI_KW / TRAIN_KW / VAT_KW` 调整规则（纯规则、仅依赖标准库，可 `python -c` 直接测）。

金额口径：增值税发票取「价税合计（小写）」，火车/出租取票面总额。

> **GPU（可选）**：PaddleOCR 默认用 CPU 版 `paddlepaddle`，对本场景足够。若部署机是 **NVIDIA CUDA** 显卡，可改装对应的 `paddlepaddle-gpu`（见飞桨官网按 CUDA 版本选择）自动走显卡加速。Apple/AMD 显卡无 CUDA，保持 CPU 即可。

## 常驻（可选）

与主服务一样可用 launchd 常驻；或简单地在后台运行：
```bash
nohup ./start-ocr.sh > ocr.log 2>&1 &
```
