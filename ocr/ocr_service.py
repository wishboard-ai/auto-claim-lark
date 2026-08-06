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
    """延迟初始化 PaddleOCR（首次请求时加载模型）。兼容不同版本的构造参数。"""
    global _ocr
    if _ocr is None:
        from paddleocr import PaddleOCR
        # 不同版本构造参数不同（2.x 有 use_angle_cls/show_log；3.x 改名/移除），逐个尝试。
        last_err = None
        for kwargs in ({"lang": "ch"}, {"use_angle_cls": True, "lang": "ch"}, {}):
            try:
                _ocr = PaddleOCR(**kwargs)
                break
            except TypeError as e:
                last_err = e
                continue
        if _ocr is None:
            raise last_err or RuntimeError("无法初始化 PaddleOCR")
        log.info("PaddleOCR 模型已加载")
    return _ocr


def _lines_from_result(result) -> List[str]:
    """兼容 PaddleOCR 2.x（[[ [box,(text,score)], ... ]]）与 3.x（含 rec_texts 的结构）。"""
    lines: List[str] = []
    if not result:
        return lines
    for res in result:
        # 3.x：OCRResult，通常可通过 ['rec_texts'] 或 .json 取到文本列表
        rec_texts = None
        if isinstance(res, dict):
            rec_texts = res.get("rec_texts")
        else:
            rec_texts = getattr(res, "rec_texts", None)
            if rec_texts is None:
                try:
                    rec_texts = res["rec_texts"]  # 支持 dict-like
                except Exception:
                    rec_texts = None
        if rec_texts:
            lines.extend(str(t).strip() for t in rec_texts if str(t).strip())
            continue
        # 2.x：res 是该图的行列表，每行 [box, (text, score)]
        if isinstance(res, list):
            for item in res:
                try:
                    txt = item[1][0]
                    if txt and str(txt).strip():
                        lines.append(str(txt).strip())
                except Exception:
                    continue
    return lines


def run_ocr(image_bytes: bytes) -> List[str]:
    """对图片做 OCR，返回文本行列表。"""
    import cv2
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("无法解码图片")
    ocr = get_ocr()
    result = None
    # 3.x 优先 predict；2.x 用 ocr()（新版不接受 cls 参数）
    if hasattr(ocr, "predict"):
        try:
            result = ocr.predict(img)
        except Exception:
            result = None
    if result is None:
        try:
            result = ocr.ocr(img)
        except TypeError:
            result = ocr.ocr(img, cls=True)
    return _lines_from_result(result)


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
