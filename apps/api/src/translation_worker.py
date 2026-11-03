"""Private, local NLLB worker. Model files are downloaded once into data/translation-model."""
import json
import os
import re
import sys
from functools import lru_cache

import torch
from langdetect import DetectorFactory, detect
from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

MODEL = "facebook/nllb-200-distilled-600M"
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
DetectorFactory.seed = 0

# NLLB uses language-script tags instead of the short language tags in book metadata.
LANGUAGES = {
    "af": "afr_Latn", "am": "amh_Ethi", "ar": "arb_Arab", "az": "azj_Latn",
    "be": "bel_Cyrl", "bg": "bul_Cyrl", "bn": "ben_Beng", "bs": "bos_Latn",
    "ca": "cat_Latn", "ceb": "ceb_Latn", "cs": "ces_Latn", "cy": "cym_Latn",
    "da": "dan_Latn", "de": "deu_Latn", "el": "ell_Grek", "en": "eng_Latn",
    "es": "spa_Latn", "et": "est_Latn", "eu": "eus_Latn", "fa": "pes_Arab",
    "fi": "fin_Latn", "fil": "tgl_Latn", "fr": "fra_Latn", "ga": "gle_Latn",
    "gl": "glg_Latn", "gu": "guj_Gujr", "he": "heb_Hebr", "hi": "hin_Deva",
    "hr": "hrv_Latn", "ht": "hat_Latn", "hu": "hun_Latn", "hy": "hye_Armn",
    "id": "ind_Latn", "is": "isl_Latn", "it": "ita_Latn", "ja": "jpn_Jpan",
    "jv": "jav_Latn", "ka": "kat_Geor", "kk": "kaz_Cyrl", "km": "khm_Khmr",
    "kn": "kan_Knda", "ko": "kor_Hang", "la": "lat_Latn", "lo": "lao_Laoo",
    "lt": "lit_Latn", "lv": "lvs_Latn", "mg": "plt_Latn", "mi": "mri_Latn",
    "mk": "mkd_Cyrl", "ml": "mal_Mlym", "mn": "khk_Cyrl", "mr": "mar_Deva",
    "ms": "zsm_Latn", "mt": "mlt_Latn", "my": "mya_Mymr", "ne": "npi_Deva",
    "nl": "nld_Latn", "no": "nob_Latn", "pa": "pan_Guru", "pl": "pol_Latn",
    "ps": "pbt_Arab", "pt": "por_Latn", "ro": "ron_Latn", "ru": "rus_Cyrl",
    "si": "sin_Sinh", "sk": "slk_Latn", "sl": "slv_Latn", "sq": "als_Latn",
    "sr": "srp_Cyrl", "sv": "swe_Latn", "sw": "swh_Latn", "ta": "tam_Taml",
    "te": "tel_Telu", "th": "tha_Thai", "tr": "tur_Latn", "uk": "ukr_Cyrl",
    "ur": "urd_Arab", "uz": "uzn_Latn", "vi": "vie_Latn", "xh": "xho_Latn",
    "yi": "ydd_Hebr", "zh": "zho_Hans", "zu": "zul_Latn",
}
LANGUAGES.update({
    "ara": "arb_Arab", "eng": "eng_Latn", "tam": "tam_Taml", "hin": "hin_Deva",
    "fra": "fra_Latn", "fre": "fra_Latn", "spa": "spa_Latn", "deu": "deu_Latn",
    "ger": "deu_Latn", "ita": "ita_Latn", "por": "por_Latn", "rus": "rus_Cyrl",
    "ben": "ben_Beng", "zho": "zho_Hans", "chi": "zho_Hans", "jpn": "jpn_Jpan",
    "kor": "kor_Hang", "tel": "tel_Telu", "mal": "mal_Mlym", "mar": "mar_Deva",
    "guj": "guj_Gujr", "pan": "pan_Guru", "urd": "urd_Arab", "nld": "nld_Latn",
    "dut": "nld_Latn", "swe": "swe_Latn", "fas": "pes_Arab", "per": "pes_Arab",
    "mya": "mya_Mymr", "khm": "khm_Khmr", "lao": "lao_Laoo", "sin": "sin_Sinh",
    "nep": "npi_Deva", "npi": "npi_Deva", "fil": "tgl_Latn", "tl": "tgl_Latn",
    "zh-cn": "zho_Hans", "zh-tw": "zho_Hant", "pt-br": "por_Latn",
})


@lru_cache(maxsize=1)
def load_model():
    tokenizer = AutoTokenizer.from_pretrained(MODEL, local_files_only=True)
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    dtype = torch.float16 if device == "mps" else torch.float32
    model = AutoModelForSeq2SeqLM.from_pretrained(MODEL, use_safetensors=False, torch_dtype=dtype, low_cpu_mem_usage=True, local_files_only=True)
    model.to(device)
    model.eval()
    return tokenizer, model, device


def source_language(text, requested):
    if requested and requested != "auto":
        code = requested.lower()
        if code in LANGUAGES:
            return LANGUAGES[code]
        if re.fullmatch(r"[a-z]{3}_[A-Za-z]{4}", requested):
            return requested
    detected = detect(text)
    return LANGUAGES.get(detected, "eng_Latn")


def sentence_chunks(text, tokenizer, limit=420):
    sentences = [part.strip() for part in re.split(r"(?<=[.!?。！？।])\s+|\n+", text) if part.strip()]
    output, group, token_count = [], [], 0
    for sentence in sentences:
        tokens = len(tokenizer(sentence, add_special_tokens=False)["input_ids"])
        if tokens > limit:
            words, piece = sentence.split(), []
            for word in words:
                candidate = " ".join(piece + [word])
                if piece and len(tokenizer(candidate, add_special_tokens=False)["input_ids"]) > limit:
                    if group:
                        output.append(" ".join(group))
                        group, token_count = [], 0
                    output.append(" ".join(piece))
                    piece = [word]
                else:
                    piece.append(word)
            if piece:
                if group:
                    output.append(" ".join(group))
                    group, token_count = [], 0
                output.append(" ".join(piece))
            continue
        if group and token_count + tokens > limit:
            output.append(" ".join(group))
            group, token_count = [], 0
        group.append(sentence)
        token_count += tokens
    if group:
        output.append(" ".join(group))
    return output


def translate(text, source, target):
    tokenizer, model, device = load_model()
    source_code = source_language(text, source)
    target_code = LANGUAGES.get(target.lower(), target)
    source_id = tokenizer.convert_tokens_to_ids(source_code)
    if source_id is None or source_id == tokenizer.unk_token_id:
        raise ValueError(f"Unsupported source language: {source}")
    target_id = tokenizer.convert_tokens_to_ids(target_code)
    if target_id is None or target_id == tokenizer.unk_token_id:
        raise ValueError(f"Unsupported target language: {target}")
    tokenizer.src_lang = source_code
    translations = []
    for part in sentence_chunks(text, tokenizer):
        inputs = tokenizer(part, return_tensors="pt", truncation=True, max_length=448).to(device)
        with torch.inference_mode():
            generated = model.generate(
                **inputs,
                forced_bos_token_id=target_id,
                max_new_tokens=512,
                num_beams=1,
            )
        translations.append(tokenizer.batch_decode(generated, skip_special_tokens=True)[0])
    return " ".join(translations)


for line in sys.stdin:
    try:
        request = json.loads(line)
        if request.get("warmup"):
            print(json.dumps({"id": request.get("id", 0), "warming": True}), flush=True)
            load_model()
            print(json.dumps({"id": request.get("id", 0), "warmup": True}), flush=True)
            continue
        result = translate(request["text"], request.get("source", "auto"), request["target"])
        print(json.dumps({"id": request["id"], "translation": result}, ensure_ascii=False), flush=True)
    except Exception as error:
        print(json.dumps({"id": request.get("id"), "error": str(error)}, ensure_ascii=False), flush=True)
