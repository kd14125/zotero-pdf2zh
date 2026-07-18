from __future__ import annotations

import json
import os
import runpy
import sys
from pathlib import Path


def _box_of(character):
    visual = getattr(character, "visual_bbox", None)
    return visual.box if visual and visual.box else character.box


def _inside(box, x0, y0, x1, y1):
    cx = (box.x + box.x2) / 2
    cy = (box.y + box.y2) / 2
    return x0 <= cx <= x1 and y0 <= cy <= y1


def _coverage(box, target):
    x0, y0, x1, y1 = target
    intersection_width = max(0.0, min(box.x2, x1) - max(box.x, x0))
    intersection_height = max(0.0, min(box.y2, y1) - max(box.y, y0))
    target_area = max(1.0, (x1 - x0) * (y1 - y0))
    return intersection_width * intersection_height / target_area


def _already_detected_by_pdf2zh(page, target):
    formula_classes = {"isolate_formula", "formula"}
    for layout in getattr(page, "page_layout", []):
        if getattr(layout, "class_name", "") not in formula_classes:
            continue
        if _coverage(layout.box, target) >= 0.6:
            return True
    return False


def _collect_display_hints(mineru_page):
    hints = []
    seen = set()
    for block in mineru_page.get("para_blocks", []):
        candidates = []
        if block.get("type") == "interline_equation" and block.get("bbox"):
            candidates.append(block["bbox"])
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                if span.get("type") == "interline_equation" and span.get("bbox"):
                    candidates.append(span["bbox"])
        for bbox in candidates:
            key = tuple(bbox)
            if key not in seen:
                seen.add(key)
                hints.append(bbox)
    return hints


def _apply_missing_formula_hints(document, layout):
    pages = layout.get("pdf_info")
    if not isinstance(pages, list):
        raise RuntimeError("MinerU layout.json 缺少 pdf_info")
    total_hints = 0
    existing_hints = 0
    added_hints = 0
    added_characters = 0
    for page in document.page:
        page_number = int(getattr(page, "page_number", 0))
        if page_number < 0 or page_number >= len(pages):
            continue
        mineru_page = pages[page_number]
        page_size = mineru_page.get("page_size") or []
        if len(page_size) != 2:
            continue
        page_height = float(page_size[1])
        for hint_index, bbox in enumerate(_collect_display_hints(mineru_page), 1):
            total_hints += 1
            x0, top, x1, bottom = [float(value) for value in bbox]
            padding = 1.5
            target = (
                x0 - padding,
                page_height - bottom - padding,
                x1 + padding,
                page_height - top + padding,
            )
            if _already_detected_by_pdf2zh(page, target):
                existing_hints += 1
                continue
            matched = [
                char
                for char in page.pdf_character
                if _inside(_box_of(char), *target)
            ]
            if len(matched) < 3:
                continue
            existing = sum(1 for char in matched if getattr(char, "formula_layout_id", None))
            if existing / len(matched) >= 0.6:
                continue
            formula_id = 900000 + page_number * 1000 + hint_index
            changed = 0
            for char in matched:
                if not getattr(char, "formula_layout_id", None):
                    char.formula_layout_id = formula_id
                    changed += 1
            if changed:
                added_hints += 1
                added_characters += changed
    print(
        f"[MinerU] 检查 {total_hints} 个行间公式，PDF2ZH 已识别 {existing_hints} 个，补充 {added_hints} 个漏检区域，标记 {added_characters} 个字符",
        flush=True,
    )


def main():
    site_packages = os.environ.get("PDF2ZH_SITE_PACKAGES", "")
    layout_path = os.environ.get("PDF2ZH_MINERU_LAYOUT", "")
    if not site_packages or not layout_path:
        raise RuntimeError("缺少 PDF2ZH MinerU 公式增强环境参数")
    sys.path.insert(0, site_packages)
    layout = json.loads(Path(layout_path).read_text(encoding="utf-8"))

    from babeldoc.format.pdf.document_il.midend.paragraph_finder import ParagraphFinder
    import pdf2zh_next.high_level as pdf2zh_high_level

    original_process = ParagraphFinder.process

    def process_with_mineru_hints(self, document):
        _apply_missing_formula_hints(document, layout)
        return original_process(self, document)

    ParagraphFinder.process = process_with_mineru_hints

    async def translate_in_current_process(settings, file):
        config = pdf2zh_high_level.create_babeldoc_config(settings, file)
        async for event in pdf2zh_high_level.babeldoc_translate(config):
            yield event

    # PDF2ZH Next normally starts another Windows process. Run BabelDOC in this
    # already isolated launcher so the formula-classification patch remains active.
    pdf2zh_high_level._translate_in_subprocess = translate_in_current_process
    runpy.run_module("pdf2zh_next.main", run_name="__main__")


if __name__ == "__main__":
    main()
