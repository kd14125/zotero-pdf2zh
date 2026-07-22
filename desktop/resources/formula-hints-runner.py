from __future__ import annotations

import json
import os
import runpy
import shutil
import subprocess
import sys
from pathlib import Path


UNSAFE_LATEX = (
    "\\input",
    "\\include",
    "\\write18",
    "\\openin",
    "\\openout",
    "\\usepackage",
    "\\documentclass",
    "\\catcode",
    "\\special",
)
FORMULA_LAYOUT_BASE = 9100000


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


def _target_box(asset):
    x0, top, x1, bottom = asset["bbox"]
    page_height = asset["pageSize"][1]
    padding = 1.5
    return (
        float(x0) - padding,
        float(page_height) - float(bottom) - padding,
        float(x1) + padding,
        float(page_height) - float(top) + padding,
    )


def _formula_id(formula):
    values = [
        getattr(char, "formula_layout_id", None)
        for char in getattr(formula, "pdf_character", [])
    ]
    values = [value for value in values if value]
    return max(set(values), key=values.count) if values else None


def _overlap_score(box, target):
    x0, y0, x1, y1 = target
    width = max(0.0, min(box.x2, x1) - max(box.x, x0))
    height = max(0.0, min(box.y2, y1) - max(box.y, y0))
    intersection = width * height
    box_area = max(1.0, (box.x2 - box.x) * (box.y2 - box.y))
    target_area = max(1.0, (x1 - x0) * (y1 - y0))
    return intersection / min(box_area, target_area)


def _map_formula_objects(document, assets, formula_id_to_asset, formula_objects):
    mapped = 0
    assets_by_page = {}
    for asset in assets:
        assets_by_page.setdefault(int(asset["page"]), []).append(asset)
    for page in document.page:
        page_number = int(getattr(page, "page_number", -1))
        page_assets = assets_by_page.get(page_number, [])
        for paragraph in page.pdf_paragraph:
            for composition in paragraph.pdf_paragraph_composition:
                formula = composition.pdf_formula
                if not formula or not formula.box:
                    continue
                asset = formula_id_to_asset.get(_formula_id(formula))
                if asset is None and page_assets:
                    candidates = [
                        (_overlap_score(formula.box, item["targetBox"]), item)
                        for item in page_assets
                    ]
                    score, candidate = max(candidates, key=lambda item: item[0])
                    if score >= 0.25:
                        asset = candidate
                if asset is not None:
                    formula_objects[id(formula)] = asset
                    mapped += 1
    print(f"[MinerU] 排版前映射 {mapped} 个 BabelDOC 公式对象", flush=True)


def _mark_redraw_formulas(document, assets, formula_id_to_asset):
    matched_assets = 0
    matched_characters = 0
    pages = {int(getattr(page, "page_number", -1)): page for page in document.page}
    for asset_index, asset in enumerate(assets):
        page = pages.get(int(asset["page"]))
        if page is None:
            continue
        target = _target_box(asset)
        matched = [
            char for char in page.pdf_character if _inside(_box_of(char), *target)
        ]
        if not matched:
            continue
        formula_id = FORMULA_LAYOUT_BASE + asset_index
        for char in matched:
            char.formula_layout_id = formula_id
        formula_id_to_asset[formula_id] = asset
        matched_assets += 1
        matched_characters += len(matched)
    print(
        f"[MinerU] 矢量重绘匹配 {matched_assets}/{len(assets)} 个公式，合并 {matched_characters} 个源字符",
        flush=True,
    )


def _compile_latex(asset, command, work_root, pymupdf):
    latex = str(asset.get("latex") or "").strip()
    if not latex or any(token.lower() in latex.lower() for token in UNSAFE_LATEX):
        raise RuntimeError("公式包含不允许的 LaTeX 命令")
    formula_root = work_root / asset["id"]
    formula_root.mkdir(parents=True, exist_ok=True)
    tex_path = formula_root / "formula.tex"
    style = "\\displaystyle " if asset.get("display") else ""
    tex_path.write_text(
        "\\documentclass[border=0pt]{standalone}\n"
        "\\usepackage{amsmath,amssymb}\n"
        "\\begin{document}\n"
        f"${style}{latex}$\n"
        "\\end{document}\n",
        encoding="utf-8",
    )
    result = subprocess.run(
        [
            command,
            "-no-shell-escape",
            "-interaction=nonstopmode",
            "-halt-on-error",
            "formula.tex",
        ],
        cwd=formula_root,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=90,
        check=False,
    )
    pdf_path = formula_root / "formula.pdf"
    if result.returncode or not pdf_path.exists():
        detail = (result.stdout + "\n" + result.stderr)[-2000:]
        raise RuntimeError(f"LaTeX 编译失败：{detail.strip()}")
    document = pymupdf.open(pdf_path)
    try:
        rect = document[0].rect
        asset["width"] = float(rect.width)
        asset["height"] = float(rect.height)
    finally:
        document.close()
    asset["pdfPath"] = str(pdf_path)


def _convert_svg(asset, work_root, pymupdf):
    svg_path = Path(asset["svgPath"])
    if not svg_path.is_file():
        raise RuntimeError("MathJax SVG 文件不存在")
    formula_root = work_root / asset["id"]
    formula_root.mkdir(parents=True, exist_ok=True)
    pdf_path = formula_root / "formula.pdf"
    svg = pymupdf.open(stream=svg_path.read_bytes(), filetype="svg")
    try:
        pdf_path.write_bytes(svg.convert_to_pdf())
    finally:
        svg.close()
    document = pymupdf.open(pdf_path)
    try:
        rect = document[0].rect
        asset["width"] = float(rect.width)
        asset["height"] = float(rect.height)
    finally:
        document.close()
    asset["pdfPath"] = str(pdf_path)


def _prepare_formula_assets(manifest_path, pymupdf):
    manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    work_root = Path(manifest_path).parent / "compiled"
    work_root.mkdir(parents=True, exist_ok=True)
    latex_command = manifest.get("latexCommand") or shutil.which("pdflatex")
    assets = []
    failures = []
    for raw in manifest.get("formulas", []):
        asset = dict(raw)
        try:
            if asset.get("svgPath"):
                _convert_svg(asset, work_root, pymupdf)
            elif latex_command:
                _compile_latex(asset, latex_command, work_root, pymupdf)
            else:
                raise RuntimeError(
                    asset.get("renderError")
                    or "MathJax 渲染失败且未安装 LaTeX 回退组件"
                )
            if asset.get("width", 0) <= 0 or asset.get("height", 0) <= 0:
                raise RuntimeError("公式矢量尺寸无效")
            asset["targetBox"] = _target_box(asset)
            assets.append(asset)
        except Exception as error:
            failures.append(f"{asset.get('id', '?')}: {error}")
    print(
        f"[MinerU] 已准备 {len(assets)} 个矢量公式，跳过 {len(failures)} 个",
        flush=True,
    )
    for failure in failures[:5]:
        print(f"[MinerU] {failure}", flush=True)
    return assets


class VectorFormulaPlaceholder:
    def __init__(
        self,
        asset,
        box_class,
        placements,
        x=None,
        y=None,
        scale=1.0,
        placed=False,
    ):
        self.asset = asset
        self._box_class = box_class
        self._placements = placements
        self.x = x
        self.y = y
        self.scale = scale
        self.placed = placed
        self.formular = None
        self.char = None
        self.unicode = None
        self.font_size = 10.0
        self.can_passthrough = False
        self.can_break_line = True
        self.is_space = False
        self.is_hung_punctuation = False
        self.is_cannot_appear_in_line_end_punctuation = False
        self.is_cjk_char = False
        self.mixed_character_blacklist = False

    def try_get_unicode(self):
        return None

    @property
    def width(self):
        if self.placed:
            return float(self.asset["width"])
        target = self.asset["targetBox"]
        return max(float(self.asset["width"]), float(target[2] - target[0]) + 3.0)

    @property
    def height(self):
        return float(self.asset["height"])

    @property
    def box(self):
        x = self.x or 0.0
        y = self.y or 0.0
        return self._box_class(
            x=x,
            y=y,
            x2=x + self.width * self.scale,
            y2=y + self.height * self.scale,
        )

    def relocate(self, x, y, scale):
        baseline_drop = max(0.0, self.height - 10.0)
        return VectorFormulaPlaceholder(
            self.asset,
            self._box_class,
            self._placements,
            x,
            y - baseline_drop * scale,
            scale,
            True,
        )

    def render(self):
        box = self.box
        record = {
            "assetId": self.asset["id"],
            "page": int(self.asset["page"]),
            "x": float(box.x),
            "y": float(box.y),
            "x2": float(box.x2),
            "y2": float(box.y2),
            "scale": float(self.scale),
        }
        if record not in self._placements:
            self._placements.append(record)
        return [], [], []


def _expand_formula_paragraphs(document, formula_objects):
    expanded = 0
    for page in document.page:
        targets = []
        for paragraph in page.pdf_paragraph:
            if not paragraph.box:
                continue
            paragraph_assets = []
            for composition in paragraph.pdf_paragraph_composition:
                formula = composition.pdf_formula
                asset = formula_objects.get(id(formula)) if formula else None
                if asset:
                    paragraph_assets.append(asset)
            if not paragraph_assets:
                continue
            extras = []
            for asset in paragraph_assets:
                source_height = asset["targetBox"][3] - asset["targetBox"][1]
                extras.append(max(0.0, float(asset["height"]) - min(source_height, 10.0) + 4.0))
            extra = min(30.0, max(extras, default=0.0))
            if extra > 0.5:
                targets.append((paragraph, extra))
        for target, extra in targets:
            original_bottom = target.box.y
            column_x0, column_x1 = target.box.x, target.box.x2
            target.box.y -= extra
            for paragraph in page.pdf_paragraph:
                if paragraph is target or not paragraph.box:
                    continue
                same_column = not (
                    paragraph.box.x2 <= column_x0 or paragraph.box.x >= column_x1
                )
                if same_column and paragraph.box.y2 <= original_bottom:
                    paragraph.box.y -= extra
                    paragraph.box.y2 -= extra
            expanded += 1
    if expanded:
        print(f"[MinerU] 为 {expanded} 个公式段落扩展行高并下移后续正文", flush=True)


def _translated_target(document, asset, placement, dual, translate_first, alternating):
    original_width, original_height = [float(value) for value in asset["pageSize"]]
    page_index = int(asset["page"])
    offset_x = 0.0
    offset_y = 0.0
    if dual and alternating:
        page_index = page_index * 2 + (0 if translate_first else 1)
    if page_index < 0 or page_index >= document.page_count:
        return None
    page = document[page_index]
    if dual and not alternating:
        if page.rect.width >= original_width * 1.8:
            offset_x = 0.0 if translate_first else original_width
        elif page.rect.height >= original_height * 1.8:
            offset_y = 0.0 if translate_first else original_height
    return page, offset_x, offset_y


def _fitz_rect(box, page_height, offset_x=0.0, offset_y=0.0):
    x0, y0, x1, y1 = [float(value) for value in box]
    return (
        x0 + offset_x,
        page_height - y1 + offset_y,
        x1 + offset_x,
        page_height - y0 + offset_y,
    )


def _finalize_pdf(path, assets_by_id, placements, source_boxes, pymupdf):
    lower_name = path.name.lower()
    dual = ".dual." in lower_name
    translate_first = "--dual-translate-first" in sys.argv
    alternating = "--use-alternating-pages-dual" in sys.argv
    document = pymupdf.open(path)
    formula_documents = {}
    changed = 0
    try:
        for placement in placements:
            asset = assets_by_id.get(placement["assetId"])
            if not asset:
                continue
            target = _translated_target(
                document, asset, placement, dual, translate_first, alternating
            )
            if not target:
                continue
            page, offset_x, offset_y = target
            frame_height = float(asset["pageSize"][1])
            destination = pymupdf.Rect(
                *_fitz_rect(
                    [placement["x"], placement["y"], placement["x2"], placement["y2"]],
                    frame_height,
                    offset_x,
                    offset_y,
                )
            )
            cleanup = pymupdf.Rect(destination)
            cleanup.x0 -= 0.8
            cleanup.y0 -= 0.8
            cleanup.x1 += 0.8
            cleanup.y1 += 0.8
            page.draw_rect(cleanup, color=None, fill=(1, 1, 1), overlay=True)
            formula = formula_documents.get(asset["id"])
            if formula is None:
                formula = pymupdf.open(asset["pdfPath"])
                formula_documents[asset["id"]] = formula
            page.show_pdf_page(
                destination,
                formula,
                0,
                keep_proportion=False,
                overlay=True,
            )
            changed += 1
        if changed:
            temporary = path.with_suffix(path.suffix + ".mineru.tmp")
            document.save(temporary, garbage=4, deflate=True)
            document.close()
            os.replace(temporary, path)
            print(f"[MinerU] {path.name} 已写入 {changed} 个矢量公式", flush=True)
            return
    finally:
        if not document.is_closed:
            document.close()
        for formula in formula_documents.values():
            formula.close()


def _output_directory():
    try:
        index = sys.argv.index("--output")
        return Path(sys.argv[index + 1])
    except (ValueError, IndexError):
        return None


def _finalize_outputs(assets, placements, source_boxes, pymupdf):
    output = _output_directory()
    if not output or not output.exists() or not placements:
        return
    assets_by_id = {asset["id"]: asset for asset in assets}
    for path in output.rglob("*.pdf"):
        _finalize_pdf(path, assets_by_id, placements, source_boxes, pymupdf)


def main():
    site_packages = os.environ.get("PDF2ZH_SITE_PACKAGES", "")
    layout_path = os.environ.get("PDF2ZH_MINERU_LAYOUT", "")
    manifest_path = os.environ.get("PDF2ZH_FORMULA_MANIFEST", "")
    if not site_packages or not layout_path or not manifest_path:
        raise RuntimeError("缺少 PDF2ZH MinerU 公式增强环境参数")
    sys.path.insert(0, site_packages)
    layout = json.loads(Path(layout_path).read_text(encoding="utf-8"))

    from babeldoc.format.pdf.document_il.midend.paragraph_finder import ParagraphFinder
    from babeldoc.format.pdf.document_il.midend.typesetting import Typesetting
    import pdf2zh_next.high_level as pdf2zh_high_level
    import pymupdf

    assets = _prepare_formula_assets(manifest_path, pymupdf)
    placements = []
    source_boxes = {}
    formula_id_to_asset = {}
    formula_objects = {}

    original_process = ParagraphFinder.process
    original_create_units = Typesetting.create_typesetting_units
    original_typesetting_document = Typesetting.typesetting_document

    def process_with_mineru_hints(self, document):
        _apply_missing_formula_hints(document, layout)
        _mark_redraw_formulas(document, assets, formula_id_to_asset)
        return original_process(self, document)

    ParagraphFinder.process = process_with_mineru_hints

    def create_units_with_vector_formulas(self, paragraph, fonts):
        units = original_create_units(self, paragraph, fonts)
        result = []
        added = set()
        for unit in units:
            formula = getattr(unit, "formular", None)
            asset = formula_objects.get(id(formula)) if formula else None
            if not asset:
                result.append(unit)
                continue
            if formula.box:
                box = [formula.box.x, formula.box.y, formula.box.x2, formula.box.y2]
                boxes = source_boxes.setdefault(asset["id"], [])
                if box not in boxes:
                    boxes.append(box)
            if asset["id"] not in added:
                result.append(
                    VectorFormulaPlaceholder(asset, type(formula.box), placements)
                )
                added.add(asset["id"])
        return result

    Typesetting.create_typesetting_units = create_units_with_vector_formulas

    def typesetting_with_formula_space(self, document):
        _map_formula_objects(document, assets, formula_id_to_asset, formula_objects)
        _expand_formula_paragraphs(document, formula_objects)
        return original_typesetting_document(self, document)

    Typesetting.typesetting_document = typesetting_with_formula_space

    async def translate_in_current_process(settings, file):
        config = pdf2zh_high_level.create_babeldoc_config(settings, file)
        async for event in pdf2zh_high_level.babeldoc_translate(config):
            yield event

    # PDF2ZH Next normally starts another Windows process. Run BabelDOC in this
    # already isolated launcher so the formula-classification patch remains active.
    pdf2zh_high_level._translate_in_subprocess = translate_in_current_process
    exit_code = 0
    try:
        runpy.run_module("pdf2zh_next.main", run_name="__main__")
    except SystemExit as error:
        exit_code = int(error.code or 0)
    if not exit_code:
        _finalize_outputs(assets, placements, source_boxes, pymupdf)
    print(
        f"[MinerU] 排版放置 {len(placements)} 个公式，记录 {sum(map(len, source_boxes.values()))} 个原公式框",
        flush=True,
    )
    if exit_code:
        raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
