"""
纯规则的票种分类与字段抽取（仅依赖标准库 re），从 OCR 文本行结构化出发票字段。
与 ocr_service.py 分离，便于在无 paddlepaddle 环境下单独测试与调参。
"""
import re
from typing import Optional, List, Dict, Any

MONEY = r"([0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{1,2}|[0-9]+\.[0-9]{1,2})"

TAXI_KW = ["出租车", "出租汽车", "TAXI", "taxi", "里程", "燃油附加", "叫车", "网约车"]
TRAIN_KW = ["铁路电子", "火车票", "中国铁路", "12306", "始发站", "到达站"]
VAT_KW = ["增值税", "发票代码", "价税合计", "销售方", "购买方", "纳税人识别号", "税额"]


def clean_amount(s: Optional[str]) -> Optional[str]:
    if not s:
        return None
    return s.replace(",", "")


def find_date(text: str) -> Optional[str]:
    m = re.search(r"(20\d{2})\s*[-年./]\s*(\d{1,2})\s*[-月./]\s*(\d{1,2})", text)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    return None


def all_amounts(text: str) -> List[float]:
    vals = []
    for m in re.finditer(MONEY, text):
        try:
            vals.append(float(m.group(1).replace(",", "")))
        except Exception:
            pass
    return vals


def largest_amount(text: str) -> Optional[str]:
    vals = all_amounts(text)
    return f"{max(vals):.2f}" if vals else None


# 企业名后缀白名单（避免用裸「社/部」等造成误匹配，如「统一社会信用代码」）
_COMPANY_RE = re.compile(
    r"[\u4e00-\u9fa5（）()·]{2,}?"
    r"(?:有限责任公司|股份有限公司|有限公司|分公司|公司|集团|厂|商行|商店|商贸|"
    r"超市|酒店|饭店|宾馆|旅行社|事务所|合作社|研究院|研究所|学校|医院|银行股份|中心)"
)
# 命中这些词的候选一律丢弃（多为标签/字段名而非公司名）
_COMPANY_BAD = ("代码", "信用", "识别", "账号", "开户", "地址", "电话", "税务", "社会")


def _find_companies(full: str):
    out = []
    for c in _COMPANY_RE.findall(full):
        c = c.strip()
        if len(c) < 3:
            continue
        if any(b in c for b in _COMPANY_BAD):
            continue
        if c not in out:
            out.append(c)
    return out


def extract_vat(full: str, joined: str) -> Dict[str, Any]:
    amount = None
    m = re.search(r"价税合计[\s\S]{0,20}?[（(]?\s*小写\s*[)）]?[\s\S]{0,6}?[¥￥]?\s*" + MONEY, full)
    if not m:
        m = re.search(r"价税合计[\s\S]{0,20}?[¥￥]\s*" + MONEY, full)
    if m:
        amount = clean_amount(m.group(1))
    if not amount:
        amount = largest_amount(full)

    tax = None
    mt = re.search(r"合\s*计[\s\S]{0,10}?[¥￥]\s*" + MONEY + r"[\s\S]{0,10}?[¥￥]\s*" + MONEY, full)
    if mt:
        tax = clean_amount(mt.group(2))

    inv = None
    mi = re.search(r"发票号码[:：]?\s*([0-9]{8,20})", full)
    if mi:
        inv = mi.group(1)
    else:
        mi = re.search(r"(?<!\d)(\d{20})(?!\d)", joined)
        if mi:
            inv = mi.group(1)

    companies = _find_companies(full)
    seller = companies[-1] if companies else None
    buyer = companies[0] if len(companies) >= 2 else None

    return {
        "type": "vat",
        "amount": amount,
        "date": find_date(full),
        "sellerName": seller,
        "buyerName": buyer,
        "invoiceNo": inv,
        "taxAmount": tax,
        "summary": None,
    }


def extract_train(full: str, joined: str) -> Dict[str, Any]:
    train_num = None
    mt = re.search(r"([GDCZTKLgdcztkl]\d{1,4})(?![0-9A-Za-z])", joined)
    if mt:
        train_num = mt.group(1).upper()
    stations = re.findall(r"([\u4e00-\u9fa5]{1,10}?站)", full)
    route = " → ".join(stations[:2]) if stations else None

    amount = None
    ma = re.search(r"[¥￥]\s*" + MONEY, full)
    if ma:
        amount = clean_amount(ma.group(1))
    else:
        amount = largest_amount(full)

    inv = None
    mi = re.search(r"(?<!\d)(\d{9,})(?!\d)", joined)
    if mi:
        inv = mi.group(1)

    summary = " ".join([x for x in [route, train_num] if x]) or None
    return {
        "type": "train",
        "amount": amount,
        "date": find_date(full),
        "sellerName": "中国铁路",
        "buyerName": None,
        "invoiceNo": inv,
        "taxAmount": None,
        "summary": summary,
    }


def extract_taxi(full: str, joined: str) -> Dict[str, Any]:
    amount = None
    ma = re.search(r"金\s*额[\s\S]{0,6}?[¥￥]?\s*" + MONEY, full)
    if ma:
        amount = clean_amount(ma.group(1))
    else:
        amount = largest_amount(full)

    inv = None
    mi = re.search(r"发票号码[:：]?\s*([0-9]{6,})", full)
    if mi:
        inv = mi.group(1)

    dist = re.search(r"([0-9]+(?:\.[0-9]+)?)\s*(?:公里|km|KM|千米)", full)
    summary = f"{dist.group(1)}公里" if dist else None

    return {
        "type": "taxi",
        "amount": amount,
        "date": find_date(full),
        "sellerName": "出租车",
        "buyerName": None,
        "invoiceNo": inv,
        "taxAmount": None,
        "summary": summary,
    }


def classify(joined: str) -> str:
    if any(k in joined for k in TAXI_KW):
        return "taxi"
    if any(k in joined for k in TRAIN_KW) or re.search(r"[GDCZTKL]\d{1,4}.*站", joined):
        return "train"
    if any(k in joined for k in VAT_KW):
        return "vat"
    return "unknown"


def structure(lines: List[str]) -> Dict[str, Any]:
    """从 OCR 文本行结构化出字段。"""
    full = "\n".join(lines)
    joined = "".join(lines)
    if not joined:
        return {"type": "unknown", "raw_text": ""}

    kind = classify(joined)
    if kind == "vat":
        out = extract_vat(full, joined)
    elif kind == "train":
        out = extract_train(full, joined)
    elif kind == "taxi":
        out = extract_taxi(full, joined)
    else:
        out = {"type": "unknown"}
    out["raw_text"] = full[:2000]
    return out
