"""Color presence detection for fabrication check photos.

Mirrors the pipeline in `detector.pyw` (HSV mask -> morphology -> contour
filters by area / solidity / aspect ratio / bbox density), so the same
ranges that we calibrated against real coloured cards in front of the
camera are used here.

The photo is valid when, for every colour expected by the module's
`codigos_color`, the number of card-shaped contours found is at least
the number of times that colour appears in the code (so 'bb' requires
TWO blue cards, not one).

When called with debug=True, every contour that survived the minimum
area filter is reported individually with its metrics and (if it was
rejected) the filter that rejected it. annotate_image() consumes that
detection list to draw a debug overlay on top of the original photo.
"""

from collections import Counter

import cv2
import numpy as np


# ---------------------------------------------------------------------------
# HSV ranges. Hue is 0-179 in OpenCV.
#
# Each entry is a LIST of (lower, upper) HSV tuples. Most colours need
# a single range, but 'red' wraps around H=0/180 so we OR two masks.
#
# Originally inherited from detector.pyw, tuned in May-2026 against
# real shop-floor photos at Ferralia (3.5-5 m camera distance, mixed
# fluorescent + daylight). Notes:
#  * 'yellow' had upper_S=150 < lower_S=180 in the inherited values,
#    which made the mask permanently empty. Fixed.
#  * 'orange' lower_S/V dropped from 180 to 120/140 so paler / shadowed
#    orange cards still match. Hue extended to 22 to cover the
#    orange-yellow border without clashing with yellow (which now
#    starts at 23).
#  * 'green' S/V minimums dropped from 130 to 80/90 to tolerate pastel
#    greens and greens lit by the projector (which washes saturation).
#  * 'blue' lower_S raised from 120 to 180. The previous threshold was
#    matching washed-out / cool-white pixels (projector glare on the
#    wall) as blue, generating dozens of false positives in the
#    annotated overlay. The dark blue tape on the wall already is
#    excluded by V min and that's intentional.
#  * 'red' added with two ranges (H 0-10 and H 170-179) because it
#    wraps around the Hue cylinder. Useful for red duct tape, which
#    is one of the most common cards in the shop.
# ---------------------------------------------------------------------------
_COLOR_HSV_RANGES = {
    'orange': [((5, 120, 140),    (22, 255, 255))],
    'yellow': [((23, 120, 150),   (33, 255, 255))],
    'green':  [((35, 80, 90),     (85, 255, 255))],
    'blue':   [((90, 180, 130),   (125, 255, 255))],
    'purple': [((125, 100, 100),  (145, 255, 255))],
    'pink':   [((140, 60, 150),   (179, 120, 255))],
    'red':    [((0, 120, 100),    (10, 255, 255)),
               ((170, 120, 100),  (179, 255, 255))],
}

# Debug-only wildcard categories. Scanned ONLY when debug=True and
# never mapped to any codigos_color char, so they can't count toward
# valid/missing. They exist purely to surface ribbons that the
# production palette would otherwise drop silently -- terracotas,
# browns, dark reds, dark blues, near-black tape, etc. -- with a
# bbox in the annotated overlay so we can see what the camera sees.
_DEBUG_EXTRA_RANGES = {
    'descarte': [
        # Browns / terracotas / warm dark tones (H 10-25 low V)
        ((10, 50, 40),  (25, 220, 130)),
        # Dark reds below the regular red V threshold (wraps around)
        ((0, 80, 30),   (10, 255, 100)),
        ((170, 80, 30), (179, 255, 100)),
        # Dark blues below the strict blue S threshold
        ((90, 80, 30),  (130, 200, 130)),
        # Near-black tape (low V, any hue)
        ((0, 0, 0),     (179, 100, 50)),
    ],
}

# Map Modulo.codigos_color chars to detector colour names. The model's
# help_text uses y/g/c/v/m/o/x; the detector calibrated against pink
# (instead of magenta), blue (instead of cyan) and purple (instead of
# violet), so we collapse near-equivalents to whichever range we have.
_CODE_TO_COLOR = {
    'y': 'yellow',
    'g': 'green',
    'c': 'blue',     # cyan -> blue range
    'b': 'blue',
    'v': 'purple',   # violet -> purple range
    'p': 'pink',
    'm': 'pink',     # magenta -> pink range
    'o': 'orange',
    'r': 'red',
    'x': None,       # skip
}

# Pipeline parameters. Areas are stored as a fraction of the reference
# 4K frame so they auto-scale to whatever resolution the uploaded photo
# actually has (the visor downscales to 2048 px on the longer side
# before upload).
#
# Range tuned for OBSBOT Tiny 2 mounted ~4.5 m above one edge of a 3 m
# wide table, looking at 15x5 cm coloured cards. Min area was lowered
# from 800 to 400 px² (4K equivalent ~113 px² on the compressed 2048
# frame) after seeing how small tape lands when the camera is at the
# far edge of the table or the tape is folded/partial; with the old
# threshold many real ribbons were being filtered silently before any
# reporting filter could even see them.
_REF_FRAME_AREA = 3840 * 2160
_MIN_AREA_RATIO = 400 / _REF_FRAME_AREA    # ~113 px² on a 2048x1152 frame
_MAX_AREA_RATIO = 16000 / _REF_FRAME_AREA  # ~4500 px² on a 2048x1152 frame

_SOLIDITY_MIN = 0.65
# bbox_density min lowered from 70 to 65 after watching real shop
# captures: legitimate ribbons sit around 68-90 % depending on edge
# shadows and tape wrinkles. 65 still rejects splatters and noise
# (which usually fall well below 50 %).
_BBOX_DENSITY_MIN = 65.0  # percent
# Single AR range covering both vertical and horizontal tape. The
# previous split (0.3, 0.85) / (1.15, 3.5) had a 'dead zone' around
# 1.0 designed to reject square shapes -- but real tape often photographs
# nearly square (rolled, foreshortened or seen at a bad angle), so we
# were rejecting valid detections. The solidity + bbox_density filters
# already keep random square noise out.
_ASPECT_RATIO_RANGES = ((0.25, 4.0),)

_MORPH_KERNEL = np.ones((5, 5), np.uint8)
_BLUR_KERNEL = (5, 5)


def _expected_color_names(codigos_color):
    if not codigos_color:
        return []
    out = []
    for ch in codigos_color.lower():
        name = _CODE_TO_COLOR.get(ch)
        if name:
            out.append(name)
    return out


def _evaluate_contour(cnt, total_area):
    """Run every card filter on a single contour and return either
    ('passed', metrics_dict) or (rejected_by, metrics_dict).

    metrics_dict has bbox, area, solidity, aspect_ratio, bbox_density
    so the caller can render an annotated overlay or surface the data
    in a debug panel.

    Returns None when the contour is below the minimum area threshold
    (sub-pixel noise we don't even want to report).
    """
    area = cv2.contourArea(cnt)
    min_area = _MIN_AREA_RATIO * total_area
    max_area = _MAX_AREA_RATIO * total_area

    if area <= min_area:
        return None  # noise, not interesting

    metrics = {
        'area': float(round(area, 1)),
        'solidity': None,
        'aspect_ratio': None,
        'bbox_density': None,
        'bbox': None,
    }

    if area >= max_area:
        x, y, w, h = cv2.boundingRect(cnt)
        metrics['bbox'] = [int(x), int(y), int(w), int(h)]
        return 'area_too_large', metrics

    hull_area = cv2.contourArea(cv2.convexHull(cnt))
    if hull_area <= 0:
        x, y, w, h = cv2.boundingRect(cnt)
        metrics['bbox'] = [int(x), int(y), int(w), int(h)]
        return 'invalid_hull', metrics
    solidity = float(area) / float(hull_area)
    metrics['solidity'] = round(solidity, 3)

    x, y, w, h = cv2.boundingRect(cnt)
    metrics['bbox'] = [int(x), int(y), int(w), int(h)]

    if solidity < _SOLIDITY_MIN:
        return 'solidity', metrics

    if h <= 0 or w <= 0:
        return 'invalid_bbox', metrics
    ar = float(w) / float(h)
    metrics['aspect_ratio'] = round(ar, 3)
    if not any(lo < ar < hi for lo, hi in _ASPECT_RATIO_RANGES):
        return 'aspect_ratio', metrics

    bbox_area = w * h
    density = (area / bbox_area) * 100.0
    metrics['bbox_density'] = round(density, 1)
    if density < _BBOX_DENSITY_MIN:
        return 'bbox_density', metrics

    return 'passed', metrics


def _scan_color(hsv_blurred, color_name, total_area,
                ranges_source=_COLOR_HSV_RANGES, is_extra=False):
    """Return every reportable detection for a single colour.

    A colour can have multiple HSV ranges (used by 'red', which wraps
    around H=0/180, and by every wildcard category in
    _DEBUG_EXTRA_RANGES); their masks are OR'd before morphology +
    contour extraction.

    `is_extra=True` flags each detection so annotate_image can paint
    it in a distinct colour and the supervisor can tell wildcard
    matches apart from production-palette ones.
    """
    mask = None
    for lower, upper in ranges_source[color_name]:
        m = cv2.inRange(
            hsv_blurred,
            np.array(lower, dtype=np.uint8),
            np.array(upper, dtype=np.uint8),
        )
        mask = m if mask is None else cv2.bitwise_or(mask, m)
    mask = cv2.erode(mask, _MORPH_KERNEL, iterations=1)
    mask = cv2.dilate(mask, _MORPH_KERNEL, iterations=2)

    contours, _ = cv2.findContours(
        mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )

    out = []
    for cnt in contours:
        result = _evaluate_contour(cnt, total_area)
        if result is None:
            continue
        verdict, metrics = result
        out.append({
            'color': color_name,
            'passed': verdict == 'passed',
            'rejected_by': None if verdict == 'passed' else verdict,
            'is_extra': is_extra,
            **metrics,
        })
    return out


def detect_colors(image_bytes, codigos_color, debug=False):
    expected = _expected_color_names(codigos_color)
    expected_counts = Counter(expected)

    base = {
        'expected': expected,
        'expected_counts': dict(expected_counts),
    }

    if not expected:
        return {
            'valid': True,
            'cards_per_color': {},
            **base,
        }

    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if bgr is None:
        return {
            'valid': False,
            'cards_per_color': {},
            'error': 'invalid_image',
            **base,
        }

    height, width = bgr.shape[:2]
    total_area = float(width * height)

    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    blurred = cv2.GaussianBlur(hsv, _BLUR_KERNEL, 0)

    # In debug mode scan every known colour, not only the expected
    # ones, so the supervisor can see in the annotated overlay what
    # the algorithm picks up of every ribbon on the wall regardless
    # of whether the module's codigos_color asked for it. The
    # production path stays cheap (only scans expected colours).
    if debug:
        colors_to_scan = sorted(_COLOR_HSV_RANGES.keys())
    else:
        colors_to_scan = sorted(set(expected))

    cards_per_color = {}
    detections_all = []
    for color in colors_to_scan:
        color_detections = _scan_color(blurred, color, total_area)
        cards_per_color[color] = sum(1 for d in color_detections if d['passed'])
        detections_all.extend(color_detections)

    # Debug-only wildcard pass: surface ribbons outside the production
    # palette (browns, dark reds, dark blues, near-black). Never
    # counted toward valid/missing because no codigos_color char maps
    # here.
    if debug:
        for color in sorted(_DEBUG_EXTRA_RANGES.keys()):
            extra_detections = _scan_color(
                blurred, color, total_area,
                ranges_source=_DEBUG_EXTRA_RANGES,
                is_extra=True,
            )
            cards_per_color[color] = sum(1 for d in extra_detections if d['passed'])
            detections_all.extend(extra_detections)

    missing = {
        color: needed - cards_per_color.get(color, 0)
        for color, needed in expected_counts.items()
        if cards_per_color.get(color, 0) < needed
    }

    result = {
        'valid': not missing,
        'cards_per_color': cards_per_color,
        'missing': missing,
        'image_size': [width, height],
        **base,
    }
    if debug:
        result['detections'] = detections_all
    return result


# ---------------------------------------------------------------------------
# Annotated-image rendering (debug-only)
# ---------------------------------------------------------------------------

# BGR colours for the overlay (the photo is BGR while in OpenCV).
_PASSED_BGR = (0, 220, 0)        # green - production palette, valid
_REJECTED_BGR = (0, 140, 255)    # orange - production palette, filtered
_EXTRA_BGR = (255, 200, 0)       # cyan - debug wildcard (descarte)
_TEXT_BGR = (255, 255, 255)
_TEXT_SHADOW_BGR = (0, 0, 0)

_BORDER_PASSED = 4
_BORDER_REJECTED = 3


def annotate_image(image_bytes, detections, jpeg_quality=85):
    """Draw every detection on the photo and return the JPEG bytes.

    Passed contours get a thick green border; rejected ones get an
    orange border with the rejection reason next to them. Useful for
    eyeballing why a real card isn't passing (HSV range, area,
    aspect ratio, etc.).
    """
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if bgr is None:
        return image_bytes  # nothing we can do

    h_img, w_img = bgr.shape[:2]
    # Scale text and line widths so the overlay is legible regardless
    # of resolution.
    font_scale = max(0.5, min(w_img, h_img) / 1500.0)
    line_thickness = max(2, int(round(min(w_img, h_img) / 700.0)))

    for det in detections:
        bbox = det.get('bbox')
        if not bbox:
            continue
        x, y, w, h = bbox
        passed = det.get('passed')
        is_extra = det.get('is_extra', False)
        # Wildcard / 'descarte' detections always use cyan regardless
        # of whether they passed the filters; they are never part of
        # the production palette so 'OK / rejected' colour coding
        # would be misleading.
        if is_extra:
            color = _EXTRA_BGR
        else:
            color = _PASSED_BGR if passed else _REJECTED_BGR
        thickness = _BORDER_PASSED if passed else _BORDER_REJECTED
        thickness = max(thickness, line_thickness)
        cv2.rectangle(bgr, (x, y), (x + w, y + h), color, thickness)

        # Build a short label with the colour, verdict and the most
        # informative metric.
        label_parts = [det.get('color', '?')]
        if passed:
            label_parts.append('OK')
        else:
            reason = det.get('rejected_by') or 'rej'
            label_parts.append(reason)
            metric_value = None
            if reason == 'solidity':
                metric_value = det.get('solidity')
            elif reason == 'aspect_ratio':
                metric_value = det.get('aspect_ratio')
            elif reason == 'bbox_density':
                metric_value = det.get('bbox_density')
            elif reason in ('area_too_large', 'area_too_small'):
                metric_value = det.get('area')
            if metric_value is not None:
                label_parts.append(f'{metric_value}')
        label = ' '.join(str(p) for p in label_parts)

        # Place the label above the bbox; if there's no room, put it
        # inside the top-left corner.
        text_size, _ = cv2.getTextSize(
            label, cv2.FONT_HERSHEY_SIMPLEX, font_scale, line_thickness
        )
        text_w, text_h = text_size
        text_x = x
        text_y = y - 6
        if text_y - text_h < 0:
            text_y = y + text_h + 6
        # Black shadow for legibility on bright backgrounds.
        cv2.putText(
            bgr, label, (text_x + 1, text_y + 1),
            cv2.FONT_HERSHEY_SIMPLEX, font_scale,
            _TEXT_SHADOW_BGR, line_thickness + 1, cv2.LINE_AA,
        )
        cv2.putText(
            bgr, label, (text_x, text_y),
            cv2.FONT_HERSHEY_SIMPLEX, font_scale,
            _TEXT_BGR, line_thickness, cv2.LINE_AA,
        )

    ok, jpeg = cv2.imencode(
        '.jpg', bgr, [cv2.IMWRITE_JPEG_QUALITY, int(jpeg_quality)]
    )
    if not ok:
        return image_bytes
    return jpeg.tobytes()
