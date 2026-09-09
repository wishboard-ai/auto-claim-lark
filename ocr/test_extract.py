"""extract.py 的纯规则抽取单测（只依赖标准库，无需 paddlepaddle）。

运行：python -m unittest discover -s ocr -p "test_*.py"
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from extract import find_amount_in_words, structure  # noqa: E402


def vat_lines(*extra):
    return [
        "电子发票（普通发票）",
        "发票号码：25312000000123456789",
        "开票日期：2026年09月01日",
        *extra,
        "合计 ¥100.00 ¥6.00",
        "价税合计（大写）壹佰零陆元整 （小写）¥106.00",
    ]


class TestParties(unittest.TestCase):
    def test_labels_on_separate_lines(self):
        out = structure(vat_lines(
            "购买方名称：某某科技有限公司",
            "统一社会信用代码：91310000MA1K35X123",
            "销售方名称：上海测试商贸有限公司",
        ))
        self.assertEqual(out["sellerName"], "上海测试商贸有限公司")
        self.assertEqual(out["buyerName"], "某某科技有限公司")

    def test_labels_side_by_side_header(self):
        """全电发票常见版式：购买方/销售方信息并排表头，名称在后续行按左右顺序出现。"""
        out = structure(vat_lines(
            "购买方信息    销售方信息",
            "名称：某某科技有限公司    名称：上海测试商贸有限公司",
        ))
        self.assertEqual(out["sellerName"], "上海测试商贸有限公司")
        self.assertEqual(out["buyerName"], "某某科技有限公司")

    def test_no_label_falls_back_to_position(self):
        out = structure(vat_lines(
            "某某科技有限公司",
            "上海测试商贸有限公司",
        ))
        self.assertEqual(out["sellerName"], "上海测试商贸有限公司")
        self.assertEqual(out["buyerName"], "某某科技有限公司")

    def test_name_not_truncated_at_inner_suffix(self):
        """「…商贸有限公司」不能被截成「…商贸」，也不能留下「有限公司」残片。"""
        out = structure(vat_lines("销售方名称：杭州测试商贸有限公司"))
        self.assertEqual(out["sellerName"], "杭州测试商贸有限公司")

    def test_two_names_on_one_line_not_merged(self):
        out = structure(vat_lines("某某科技有限公司上海测试商贸有限公司"))
        self.assertEqual(out["buyerName"], "某某科技有限公司")
        self.assertEqual(out["sellerName"], "上海测试商贸有限公司")

    def test_label_glued_to_name_is_trimmed(self):
        out = structure(vat_lines("销售方名称上海测试商贸有限公司"))
        self.assertEqual(out["sellerName"], "上海测试商贸有限公司")

    def test_credit_code_label_not_taken_as_company(self):
        out = structure(vat_lines(
            "统一社会信用代码/纳税人识别号：91310000MA1K35X123",
            "销售方名称：上海测试商贸有限公司",
        ))
        self.assertEqual(out["sellerName"], "上海测试商贸有限公司")
        self.assertNotIn("信用", out["sellerName"])

    def test_non_company_suffix_name(self):
        out = structure(vat_lines("销售方名称：杭州第一机械厂"))
        self.assertEqual(out["sellerName"], "杭州第一机械厂")


class TestAmountInWords(unittest.TestCase):
    def test_label_with_spaces(self):
        self.assertEqual(
            find_amount_in_words("价 税 合 计 （ 大 写 ） 壹仟贰佰叁拾肆元伍角陆分"),
            "壹仟贰佰叁拾肆元伍角陆分",
        )

    def test_none_when_absent(self):
        self.assertIsNone(find_amount_in_words("合计 ¥100.00 ¥6.00"))

    def test_structure_outputs_words_and_total(self):
        out = structure(vat_lines("销售方名称：上海测试商贸有限公司"))
        self.assertEqual(out["amountInWords"], "壹佰零陆元整")
        self.assertEqual(out["amount"], "106.00")


if __name__ == "__main__":
    unittest.main()
