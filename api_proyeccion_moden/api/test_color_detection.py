import unittest

import cv2
import numpy as np

from api import color_detection


def _encode_image(image):
    ok, encoded = cv2.imencode('.jpg', image)
    if not ok:
        raise AssertionError('Could not encode synthetic test image')
    return encoded.tobytes()


class ColorDetectionRoiTests(unittest.TestCase):
    def test_production_thresholds_match_the_real_capture_adjustment(self):
        self.assertEqual(color_detection._BBOX_DENSITY_MIN, 60.0)
        self.assertEqual(
            color_detection._MIN_AREA_RATIO,
            1200 / color_detection._REF_FRAME_AREA,
        )

    def test_bottom_strip_is_ignored_but_upper_table_colour_is_detected(self):
        image = np.full((1000, 1000, 3), 255, dtype=np.uint8)
        cv2.rectangle(image, (200, 50), (225, 90), (0, 255, 0), -1)
        cv2.rectangle(image, (600, 850), (625, 890), (0, 0, 255), -1)

        result = color_detection.detect_colors(
            _encode_image(image), 'rg', debug=True
        )

        self.assertEqual(result['cards_per_color']['red'], 0)
        self.assertGreaterEqual(result['cards_per_color']['green'], 1)
        self.assertEqual(result['missing'], {'red': 1})
        self.assertEqual(result['detection_roi']['bottom_px'], 270)
        self.assertEqual(result['detection_roi']['cutoff_y'], 730)

    def test_tiny_colour_mark_is_below_new_area_floor(self):
        image = np.full((1000, 1000, 3), 255, dtype=np.uint8)
        cv2.rectangle(image, (500, 500), (505, 505), (0, 255, 0), -1)

        result = color_detection.detect_colors(
            _encode_image(image), 'g', debug=True
        )

        self.assertEqual(result['cards_per_color']['green'], 0)
        self.assertEqual(result['missing'], {'green': 1})

    def test_debug_annotation_marks_the_ignored_region(self):
        image = np.full((1000, 1000, 3), 255, dtype=np.uint8)
        image_bytes = _encode_image(image)
        result = color_detection.detect_colors(image_bytes, 'g', debug=True)

        annotated = color_detection.annotate_image(
            image_bytes,
            result['detections'],
            detection_roi=result['detection_roi'],
        )
        decoded = cv2.imdecode(
            np.frombuffer(annotated, dtype=np.uint8), cv2.IMREAD_COLOR
        )

        self.assertEqual(decoded.shape[:2], (1000, 1000))
        self.assertGreater(int(decoded[100, 500].mean()), 240)
        self.assertLess(int(decoded[900, 500].mean()), 200)


if __name__ == '__main__':
    unittest.main()
