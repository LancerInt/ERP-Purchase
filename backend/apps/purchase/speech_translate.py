"""Translate dictated speech transcripts to English via Gemini.

Reuses the same ``GEMINI_API_KEY`` + ``google.generativeai`` client as the
quote / weighment extractors — text-in / text-out, no file upload. The
browser's Web Speech API transcribes in the spoken language (set via the
language picker); this turns that transcript into professional English so
forms can be dictated in any language.

On any failure it returns the ORIGINAL transcript as ``translated_text``
so the voice flow degrades gracefully (you still get the raw words).
"""
from __future__ import annotations

import logging
import os
from common.ai_log import generate_logged

logger = logging.getLogger(__name__)

# Model override order: translate-specific → generic primary → default.
TRANSLATE_MODEL = (
    os.environ.get('GEMINI_TRANSLATE_MODEL')
    or os.environ.get('GEMINI_PRIMARY_MODEL')
    or 'gemini-2.5-flash'
)


def translate_to_english(text: str, source_language: str = '') -> dict:
    """Return {status, translated_text, model_used?, error?}.

    `translated_text` is always populated — the original transcript when
    translation can't run — so the caller can always fill the field.
    """
    text = (text or '').strip()
    if not text:
        return {'status': 'error', 'error': 'No text to translate.', 'translated_text': ''}

    try:
        import google.generativeai as genai  # type: ignore
    except ImportError as exc:
        return {'status': 'error', 'error': f'google-generativeai not installed ({exc}).',
                'translated_text': text}

    api_key = os.environ.get('GEMINI_API_KEY', '').strip()
    if not api_key:
        return {'status': 'error', 'error': 'GEMINI_API_KEY not configured in backend/.env',
                'translated_text': text}

    lang_hint = f' The source language is {source_language}.' if source_language else ''
    prompt = (
        'You are a translator embedded in an ERP form. Translate the following '
        'DICTATED text into natural, professional English suitable for a business '
        'note. If it is already English, return it unchanged apart from fixing '
        'obvious speech-to-text errors. Preserve numbers, units, product names and '
        'codes exactly. Output ONLY the final English text — no quotes, no labels, '
        'no explanation.' + lang_hint + '\n\nText:\n' + text
    )

    try:
        genai.configure(api_key=api_key)
        model = genai.GenerativeModel(TRANSLATE_MODEL)
        # 90s timeout via request_options — without it the SDK's own default
        # (600s) outlives gunicorn's 120s worker timeout (render.yaml), so a
        # slow response gets the worker SIGKILLed instead of returning a
        # clean error. Matches the convention already used in
        # quote_gemini_extractor.py.
        resp = generate_logged(model, prompt, what='speech-translate',
                               model_name=TRANSLATE_MODEL,
                               request_options={'timeout': 90})
        out = (getattr(resp, 'text', '') or '').strip()
        if not out:
            return {'status': 'error', 'error': 'Empty translation from model.',
                    'translated_text': text}
        return {'status': 'success', 'translated_text': out, 'model_used': TRANSLATE_MODEL}
    except Exception as exc:  # noqa: BLE001 — surface any SDK/network error as graceful fallback
        logger.exception('Gemini speech translation failed')
        return {'status': 'error', 'error': f'{type(exc).__name__}: {exc}',
                'translated_text': text}


from rest_framework.decorators import api_view, permission_classes  # noqa: E402
from rest_framework.permissions import IsAuthenticated  # noqa: E402
from rest_framework.response import Response  # noqa: E402


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def translate_speech(request):
    """POST { text, source_language? } → { status, translated_text, ... }.

    Text-only: the browser's Web Speech API transcribes the dictation in the
    chosen language and we translate that transcript to English here. Keeping
    audio off the wire matters on weak mobile links. Always returns a usable
    `translated_text` (the raw transcript on any failure).
    """
    text = request.data.get('text', '')
    source_language = request.data.get('source_language', '') or ''
    return Response(translate_to_english(text, source_language))
