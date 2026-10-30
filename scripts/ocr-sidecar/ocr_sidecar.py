#!/usr/bin/env python3
"""Sidecar de OCR local de Asistenta (opcional).

Uso: python ocr_sidecar.py --model ppocr|glm --input <imagen o PDF>
     python ocr_sidecar.py --model ppocr --check

Escribe UNA línea JSON en stdout: {"ok": true, "text": "...", "pages": N}
o {"ok": false, "error": "missing_engine"|"bad_input"|"failed", "detail": "..."}.
Sin red salvo la primera descarga de los pesos; sin APIs de pago.
"""
import argparse
import json
import os
import sys
import tempfile

MAX_PAGES = 20
PDF_SCALE = 200 / 72  # 200 ppp


def emit(obj, code=0):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    sys.exit(code)


def ppocr_engine():
    from rapidocr import LangDet, LangRec, ModelType, OCRVersion, RapidOCR

    eng = RapidOCR(params={
        "Det.ocr_version": OCRVersion.PPOCRV5, "Rec.ocr_version": OCRVersion.PPOCRV5,
        "Rec.lang_type": LangRec.LATIN, "Det.lang_type": LangDet.CH,
        "Rec.model_type": ModelType.MOBILE, "Det.model_type": ModelType.MOBILE,
    })

    def run(path):
        r = eng(path)
        if r.txts is None:
            return ""
        # agrupa las cajas en líneas por su altura
        items = sorted(zip(r.boxes.tolist(), r.txts), key=lambda b: sum(p[1] for p in b[0]) / 4)
        lines, cur, cy = [], [], None
        for box, t in items:
            y = sum(p[1] for p in box) / 4
            h = abs(box[3][1] - box[0][1]) or 10
            if cy is not None and abs(y - cy) > h * 0.6:
                lines.append(cur)
                cur = []
            cur.append((min(p[0] for p in box), t))
            cy = y
        if cur:
            lines.append(cur)
        return "\n".join(" ".join(t for _, t in sorted(line)) for line in lines)

    return run


def glm_engine():
    import torch
    from transformers import AutoModelForImageTextToText, AutoProcessor

    repo = "zai-org/GLM-OCR"
    proc = AutoProcessor.from_pretrained(repo)
    model = AutoModelForImageTextToText.from_pretrained(repo, dtype=torch.bfloat16).eval()

    def run(path):
        msgs = [{"role": "user", "content": [{"type": "image", "url": path},
                                             {"type": "text", "text": "Text Recognition:"}]}]
        inp = proc.apply_chat_template(msgs, tokenize=True, add_generation_prompt=True,
                                       return_dict=True, return_tensors="pt")
        with torch.inference_mode():
            out = model.generate(**inp, max_new_tokens=2048, do_sample=False)
        return proc.batch_decode(out[:, inp["input_ids"].shape[1]:], skip_special_tokens=True)[0]

    return run


def pdf_pages(path, tmp):
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(path)
    out = []
    for i in range(min(len(pdf), MAX_PAGES)):
        img = pdf[i].render(scale=PDF_SCALE).to_pil()
        p = os.path.join(tmp, f"p{i + 1}.png")
        img.save(p)
        out.append(p)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", choices=["ppocr", "glm"], default="ppocr")
    ap.add_argument("--input")
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    try:
        run = glm_engine() if a.model == "glm" else ppocr_engine()
    except ImportError as e:
        emit({"ok": False, "error": "missing_engine", "detail": str(e)}, 2)
    if a.check:
        emit({"ok": True, "text": "", "pages": 0, "model": a.model})
    if not a.input or not os.path.isfile(a.input):
        emit({"ok": False, "error": "bad_input", "detail": "no existe el fichero"}, 2)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            if a.input.lower().endswith(".pdf"):
                try:
                    pages = pdf_pages(a.input, tmp)
                except ImportError as e:
                    emit({"ok": False, "error": "missing_engine", "detail": str(e)}, 2)
            else:
                pages = [a.input]
            texts = [run(p).strip() for p in pages]
        sep = "\n\n"
        text = sep.join(f"--- página {i + 1} ---\n{t}" for i, t in enumerate(texts)) if len(texts) > 1 else (texts[0] if texts else "")
        emit({"ok": True, "text": text, "pages": len(texts)})
    except Exception as e:  # noqa: BLE001 - el error vuelve a Node como texto
        emit({"ok": False, "error": "failed", "detail": f"{type(e).__name__}: {e}"[:500]}, 1)


if __name__ == "__main__":
    main()
