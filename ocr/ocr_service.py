"""
本地 PaddleOCR 发票识别微服务（全本地、零 API 成本）。

流程：接收图片 -> PaddleOCR 识别文字 -> extract.structure 规则抽取 -> 返回统一 JSON，
供 Node 端 recognize.ts（OCR_PROVIDER=paddle）调用，下游字段映射/审批不变。

纯规则逻辑在 extract.py（仅依赖标准库，可单独测试）。启动见 ocr/README.md。
"""
import logging
from typing import List

import numpy as np
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

import extract

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("paddle-ocr")

app = FastAPI(title="auto-claim-lark PaddleOCR service")

_ocr = None


def get_ocr():
    """延迟初始化 PaddleOCR（首次请求时加载模型）。"""
    global _ocr
    if _ocr is None:
        from paddleocr import PaddleOCR
        _ocr = PaddleOCR(use_angle_cls=True, lang="ch", show_log=False)
        log.info("PaddleOCR 模型已加载")
    return _ocr


def run_ocr(image_bytes: bytes) -> List[str]:
    """对图片做 OCR，返回文本行列表。"""
    import cv2
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("无法解码图片")
    result = get_ocr().ocr(img, cls=True)
    lines: List[str] = []
    blocks = result[0] if result and isinstance(result, list) and result[0] else []
    for item in blocks or []:
        try:
            txt = item[1][0]
            if txt and str(txt).strip():
                lines.append(str(txt).strip())
        except Exception:
            continue
    return lines


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/recognize")
async def recognize_endpoint(request: Request):
    body = await request.body()
    if not body:
        return JSONResponse({"type": "unknown", "error": "empty body"}, status_code=400)
    try:
        lines = run_ocr(body)
        result = extract.structure(lines)
        log.info(
            "识别结果 type=%s amount=%s date=%s",
            result.get("type"), result.get("amount"), result.get("date"),
        )
        return result
    except Exception as e:  # noqa
        log.exception("识别失败")
        return JSONResponse({"type": "unknown", "error": str(e)}, status_code=500)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
