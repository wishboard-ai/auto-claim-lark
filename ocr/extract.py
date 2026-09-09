"""
纯规则的票种分类与字段抽取（仅依赖标准库 re），从 OCR 文本行结构化出发票字段。
与 ocr_service.py 分离，便于在无 paddlepaddle 环境下单独测试与调参。
"""
import re
from typing import Optional, List, Dict, Any

MONEY = r"([0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{1,2}|[0-9]+\.[0-9]{1,2})"

# 「价税合计」「小写」在 OCR/PDF 中常被拆成带空格的单字（如「价 税 合 计」「（ 小 写 ）」），
# 用允许字符间空白的模式匹配，避免漏识别导致回退到税前「金额」。
VAT_TOTAL_LABEL = r"价\s*税\s*合\s*计"
XIAOXIE = r"小\s*写"
DAXIE = r"大\s*写"
# 中文大写金额字符集（含常见异体）：用于抓取「价税合计（大写）」原文，交给上层解析并校正小写数字。
CN_AMOUNT_CHARS = r"零〇壹贰貳弐叁參参叄肆伍陆陸柒捌玖拾佰仟万萬亿億元圆圓角分整正"

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


# 企业名抽取（避免用裸「社/部」等造成误匹配，如「统一社会信用代码」）。
# 分两类后缀：
# - _COMPANY_TAIL：以「公司」结尾（最常见）。前缀用 (?!公司) 逐字前进，保证匹配到「公司」即停：
#   既避免非贪婪量词把「测试商贸有限公司」截成「测试商贸」并留下垃圾「有限公司」，
#   也避免贪婪量词把同一行相邻的两个公司名粘成一个。
# - _OTHER_TAIL：厂/集团/医院/中心 等结尾，要求其后不再紧跟汉字（否则多为名称中间的字），
#   仅在该行找不到「公司」名时才使用。
_COMPANY_TAIL = r"(?:有限责任公司|股份有限公司|有限公司|分公司|公司)"
_OTHER_TAIL = (
    r"(?:集团|厂|商行|商店|商贸|超市|酒店|饭店|宾馆|旅行社|事务所|合作社|"
    r"研究院|研究所|学校|医院|银行股份|中心)"
)
_NAME_CHAR = r"(?:(?!公司)[\u4e00-\u9fa5（）()·])"
_COMPANY_RE = re.compile(_NAME_CHAR + r"{1,30}" + _COMPANY_TAIL)
_OTHER_RE = re.compile(_NAME_CHAR + r"{2,30}" + _OTHER_TAIL + r"(?![\u4e00-\u9fa5])")
# 命中这些词的候选一律丢弃（多为标签/字段名而非公司名）
_COMPANY_BAD = ("代码", "信用", "识别", "账号", "开户", "地址", "电话", "税务", "社会")
# 名称前常被 OCR 粘上的标签词，逐层剥离（如「销售方名称测试商贸有限公司」）
_NAME_LABELS = (
    "销售方信息", "购买方信息", "销售方名称", "购买方名称", "销售方", "购买方",
    "受票方", "开票方", "名称", "信息", "开票人", "收款人", "复核人", "复核", "备注",
)
# 「销售方 / 购买方」标签（OCR 常把字拆开，允许字间空白）
_SELLER_LABEL = r"销\s*售\s*方|销\s*方"
_BUYER_LABEL = r"购\s*买\s*方|购\s*方|受\s*票\s*方"


def _trim_name_label(name: str) -> str:
    """剥离名称前粘连的标签词与标点。"""
    prev = None
    while prev != name:
        prev = name
        name = name.lstrip("：: 　·（()）")
        for label in _NAME_LABELS:
            if name.startswith(label):
                name = name[len(label):]
                break
    return name.strip()


def _company_candidates(text: str):
    """逐行抽取公司名候选：优先「…公司」，该行没有时再试厂/集团/中心等后缀。"""
    out = []
    for line in text.split("\n"):
        found = _COMPANY_RE.findall(line) or _OTHER_RE.findall(line)
        for c in found:
            c = _trim_name_label(c)
            if len(c) < 4:  # 「有限公司」「某公司」这类残片不足以作为名称
                continue
            if any(b in c for b in _COMPANY_BAD):
                continue
            if c not in out:
                out.append(c)
    return out


def _company_near_label(full: str, label: str) -> Optional[str]:
    """取标签（销售方/购买方）之后窗口内的第一个公司名。找不到返回 None。"""
    for m in re.finditer(label, full):
        window = full[m.end(): m.end() + 80]
        cands = _company_candidates(window)
        if cands:
            return cands[0]
    return None


def _find_companies(full: str):
    return _company_candidates(full)


def _line_index(text: str, pos: int) -> int:
    return text.count("\n", 0, pos)


def _resolve_parties(full: str):
    """判定 (销售方, 购买方)。

    版式差异大，优先用标签定位，其次按位置启发：
    1. 两个标签在同一行（「购买方信息 | 销售方信息」并排表头）：其后的公司名按出现顺序
       与标签顺序一一对应（左购买方、右销售方）；
    2. 标签分行出现：各取标签之后窗口内的第一个公司名；
    3. 无标签：票面购买方在前、销售方在后。
    """
    companies = _company_candidates(full)
    ms = re.search(_SELLER_LABEL, full)
    mb = re.search(_BUYER_LABEL, full)

    if ms and mb and _line_index(full, ms.start()) == _line_index(full, mb.start()):
        tail = full[max(ms.end(), mb.end()):]
        cands = _company_candidates(tail)
        if len(cands) >= 2:
            first, second = cands[0], cands[1]
            return (second, first) if mb.start() < ms.start() else (first, second)

    seller = _company_near_label(full, _SELLER_LABEL) if ms else None
    buyer = _company_near_label(full, _BUYER_LABEL) if mb else None
    if seller and buyer and seller == buyer:
        # 同一个名字被两个标签都命中（窗口重叠/标签漏识）：保留销售方，购买方另取。
        buyer = next((c for c in companies if c != seller), None)
    if not seller:
        seller = next((c for c in reversed(companies) if c != buyer), None)
    if not buyer:
        buyer = next((c for c in companies if c != seller), None)
    return seller, buyer


def find_amount_in_words(text: str) -> Optional[str]:
    """抓取「价税合计（大写）」的中文大写原文。

    增值税发票只有价税合计带大写金额，语义唯一，可用于校正易取错列的小写数字。
    OCR 常把标签拆成带空格的单字，故标签与取值之间允许少量空白/括号。
    只回传原文（不在此解析成数字），由上层统一解析与勾稽。
    """
    pat = (
        r"[（(]?\s*" + DAXIE + r"\s*[)）]?\s*[:：]?\s*"
        r"([" + CN_AMOUNT_CHARS + r"][" + CN_AMOUNT_CHARS + r"\s]{1,30})"
    )
    m = re.search(pat, text)
    if not m:
        # 无「大写」标签时退而求其次：找一段以「元/圆」+「整/角/分」结尾的大写串
        m = re.search(r"([" + CN_AMOUNT_CHARS + r"]{2,20}?[元圆圓][" + CN_AMOUNT_CHARS + r"]{0,6})", text)
    if not m:
        return None
    words = re.sub(r"\s+", "", m.group(1))
    # 必须含大写数字与「元/圆」，否则多为误匹配（如「合计」等标签残留）
    if not re.search(r"[零〇壹贰貳弐叁參参叄肆伍陆陸柒捌玖]", words):
        return None
    if not re.search(r"[元圆圓]", words):
        return None
    return words


def extract_vat(full: str, joined: str) -> Dict[str, Any]:
    amount = None
    m = re.search(VAT_TOTAL_LABEL + r"[\s\S]{0,20}?[（(]?\s*" + XIAOXIE + r"\s*[)）]?[\s\S]{0,6}?[¥￥]?\s*" + MONEY, full)
    if not m:
        m = re.search(VAT_TOTAL_LABEL + r"[\s\S]{0,20}?[¥￥]\s*" + MONEY, full)
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

    seller, buyer = _resolve_parties(full)

    return {
        "type": "vat",
        "amount": amount,
        "date": find_date(full),
        "sellerName": seller,
        "buyerName": buyer,
        "invoiceNo": inv,
        "taxAmount": tax,
        "amountInWords": find_amount_in_words(full),
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
    # 优先取「价税合计（含税总额）」——部分网约车/客运电子发票同时有不含税「金额」列，
    # 若误取「金额」会得到税前金额（偏小）。价税合计才是报销总额。
    mv = re.search(VAT_TOTAL_LABEL + r"[\s\S]{0,20}?[（(]?\s*" + XIAOXIE + r"\s*[)）]?[\s\S]{0,6}?[¥￥]?\s*" + MONEY, full)
    if not mv:
        mv = re.search(VAT_TOTAL_LABEL + r"[\s\S]{0,20}?[¥￥]\s*" + MONEY, full)
    if mv:
        amount = clean_amount(mv.group(1))
    if not amount:
        ma = re.search(r"金\s*额[\s\S]{0,6}?[¥￥]?\s*" + MONEY, full)
        if ma:
            amount = clean_amount(ma.group(1))
    if not amount:
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


def classify(joined: str, full: str = "") -> str:
    # 铁路车票优先（其票面元素与增值税发票有重叠，靠强关键词区分）
    if any(k in joined for k in TRAIN_KW) or re.search(r"[GDCZTKL]\d{1,4}.*站", joined):
        return "train"
    # 具备增值税发票要素（价税合计 / 纳税人识别号）的一律归为 vat——
    # 即使服务内容是客运/出租车/网约车（如滴滴电子发票）。
    if re.search(VAT_TOTAL_LABEL, full) or "纳税人识别号" in joined:
        return "vat"
    if any(k in joined for k in TAXI_KW):
        return "taxi"
    if any(k in joined for k in VAT_KW):
        return "vat"
    return "unknown"


def structure(lines: List[str]) -> Dict[str, Any]:
    """从 OCR 文本行结构化出字段。"""
    full = "\n".join(lines)
    joined = "".join(lines)
    if not joined:
        return {"type": "unknown", "raw_text": ""}

    kind = classify(joined, full)
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
