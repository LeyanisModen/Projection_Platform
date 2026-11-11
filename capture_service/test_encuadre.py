import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import cv2


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ENCUADRE = load('moden_encuadre', 'encuadre.py')
CAPTURE_SERVICE = load('moden_capture_service_encuadre', 'capture_service.py')

PROPS = {cv2.CAP_PROP_PAN: 'pan', cv2.CAP_PROP_TILT: 'tilt', cv2.CAP_PROP_ZOOM: 'zoom'}


class FakePtzCamera:
    """DirectShow handle as the OBSBOT behaves: get returns the position,
    set moves there (unless the gimbal is stuck)."""

    def __init__(self, pan=-40.0, tilt=-62.0, zoom=0.0, opened=True, stuck=False):
        self.position = {'pan': pan, 'tilt': tilt, 'zoom': zoom}
        self.opened = opened
        self.stuck = stuck
        self.sets = []
        self.released = False

    def isOpened(self):
        return self.opened

    def get(self, prop):
        return self.position[PROPS[prop]]

    def set(self, prop, value):
        self.sets.append((PROPS[prop], value))
        if not self.stuck:
            self.position[PROPS[prop]] = value
        return True

    def release(self):
        self.released = True


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class EncuadreScriptTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.reference = Path(self.tmp.name) / 'encuadre' / 'referencia.json'
        self.clock = FakeClock()

    def tearDown(self):
        self.tmp.cleanup()

    def run_mode(self, mode, camera):
        return ENCUADRE.run(
            mode, 0, self.reference,
            open_camera=lambda index: camera,
            sleep=self.clock.sleep, monotonic=self.clock.monotonic,
        )

    def save(self, **position):
        ENCUADRE.save_reference(self.reference, {'pan': -40.0, 'tilt': -62.0, 'zoom': 0.0, **position})

    def test_saves_current_position(self):
        camera = FakePtzCamera(pan=-40, tilt=-62, zoom=5)
        result = self.run_mode('guardar', camera)
        self.assertEqual(result['resultado'], 'guardada')
        self.assertNotIn('aviso', result)
        self.assertNotIn('antes_de_ajustar', result)
        saved = json.loads(self.reference.read_text(encoding='utf-8'))
        self.assertEqual((saved['pan'], saved['tilt'], saved['zoom']), (-40, -62, 5))
        self.assertIn('guardada', saved)
        self.assertTrue(camera.released)

    def test_hand_framing_is_moved_to_whole_degrees_before_saving(self):
        # The OBSBOT app leaves the gimbal between whole degrees; a later
        # correction can only go to whole degrees, so that is what is kept.
        camera = FakePtzCamera(pan=1.4, tilt=24.6, zoom=0)
        result = self.run_mode('guardar', camera)
        self.assertEqual(result['posicion'], {'zoom': 0.0, 'pan': 1.0, 'tilt': 25.0})
        self.assertEqual(result['antes_de_ajustar']['pan'], 1.4)
        self.assertEqual(camera.position, {'pan': 1.0, 'tilt': 25.0, 'zoom': 0.0})
        saved = json.loads(self.reference.read_text(encoding='utf-8'))
        self.assertEqual((saved['pan'], saved['tilt'], saved['zoom']), (1.0, 25.0, 0.0))
        self.assertGreaterEqual(self.clock.now, ENCUADRE.SETTLE_SECONDS)

    def test_saving_factory_position_warns(self):
        result = self.run_mode('guardar', FakePtzCamera(pan=0, tilt=0, zoom=0))
        self.assertEqual(result['resultado'], 'guardada')
        self.assertIn('aviso', result)

    def test_check_without_reference_does_not_open_camera(self):
        camera = FakePtzCamera()
        result = self.run_mode('comprobar', camera)
        self.assertEqual(result['resultado'], 'sin_referencia')
        self.assertFalse(camera.released)

    def test_check_in_place_does_not_move_camera(self):
        self.save()
        camera = FakePtzCamera(pan=-41, tilt=-62, zoom=0)  # within tolerance
        result = self.run_mode('comprobar', camera)
        self.assertEqual(result['resultado'], 'ok')
        self.assertEqual(camera.sets, [])

    def test_moved_camera_is_sent_back_to_saved_position(self):
        self.save()
        camera = FakePtzCamera(pan=-12, tilt=-62, zoom=0)
        result = self.run_mode('comprobar', camera)
        self.assertEqual(result['resultado'], 'corregida')
        self.assertEqual(camera.sets, [('pan', -40.0)])
        self.assertEqual(result['antes']['pan'], -12)
        self.assertEqual(result['despues']['pan'], -40)
        self.assertTrue(camera.released)

    def test_camera_that_does_not_move_is_reported(self):
        self.save()
        camera = FakePtzCamera(pan=-12, tilt=-30, zoom=0, stuck=True)
        result = self.run_mode('comprobar', camera)
        self.assertEqual(result['resultado'], 'no_vuelve')
        self.assertEqual(sorted(axis for axis, _ in camera.sets), ['pan', 'tilt'])
        self.assertTrue(camera.released)

    def test_busy_camera(self):
        self.save()
        self.assertEqual(self.run_mode('comprobar', FakePtzCamera(opened=False))['resultado'], 'no_abre')

    def test_camera_without_ptz(self):
        self.save()
        camera = FakePtzCamera(pan=-1, tilt=-1, zoom=-1)
        self.assertEqual(self.run_mode('comprobar', camera)['resultado'], 'sin_control')
        self.assertEqual(camera.sets, [])

    def test_main_reports_errors_as_json(self):
        result = ENCUADRE.main(['encuadre.py', 'comprobar', 'x', 'ref.json'])
        self.assertEqual(result['resultado'], 'error')


class FakeProcess:
    def __init__(self, stdout='', stderr='', hang=False):
        self.stdout = stdout
        self.stderr = stderr
        self.hang = hang
        self.pid = 4242
        self.killed = False

    def communicate(self, timeout=None):
        if self.hang and not self.killed:
            raise subprocess.TimeoutExpired('encuadre.py', timeout)
        return self.stdout, self.stderr

    def kill(self):
        self.killed = True


class ServiceEncuadreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.patches = [
            patch.object(CAPTURE_SERVICE.CONFIG, 'encuadre_dir', Path(self.tmp.name)),
            patch.object(CAPTURE_SERVICE, 'get_camera'),
            patch.object(CAPTURE_SERVICE, '_log_encuadre'),
        ]
        for p in self.patches:
            p.start()
        self.camera = FakePtzCamera()
        CAPTURE_SERVICE._camera = self.camera
        with CAPTURE_SERVICE._stats_lock:
            CAPTURE_SERVICE._stats['encuadre_estado'] = 'desconocido'
            CAPTURE_SERVICE._stats['encuadre_correcciones_hoy'] = 0
            CAPTURE_SERVICE._stats['encuadre_correcciones_fecha'] = None

    def tearDown(self):
        for p in self.patches:
            p.stop()
        CAPTURE_SERVICE._camera = None
        self.tmp.cleanup()

    def run_process(self, process):
        with patch.object(CAPTURE_SERVICE.subprocess, 'Popen', return_value=process) as popen, \
                patch.object(CAPTURE_SERVICE.subprocess, 'run') as run:
            result = CAPTURE_SERVICE._run_encuadre_process('comprobar')
        return result, popen, run

    def test_releases_camera_runs_script_and_reopens(self):
        line = json.dumps({'resultado': 'ok', 'posicion': {'pan': -40, 'tilt': -62, 'zoom': 0}})
        result, popen, _ = self.run_process(FakeProcess(stdout=f'aviso del driver\n{line}\n'))
        self.assertEqual(result['resultado'], 'ok')
        self.assertTrue(self.camera.released)
        self.assertIsNone(CAPTURE_SERVICE._camera)
        command = popen.call_args.args[0]
        self.assertEqual(command[1:4], [str(CAPTURE_SERVICE.ENCUADRE_SCRIPT), 'comprobar', '0'])
        self.assertEqual(command[4], str(Path(self.tmp.name) / 'referencia.json'))
        CAPTURE_SERVICE.get_camera.assert_called_once()

    def test_hung_script_is_killed_and_camera_reopened(self):
        result, _, run = self.run_process(FakeProcess(hang=True))
        self.assertEqual(result['resultado'], 'error')
        self.assertIn('sin respuesta', result['detalle'])
        CAPTURE_SERVICE.get_camera.assert_called_once()
        if CAPTURE_SERVICE.os.name == 'nt':
            self.assertIn('taskkill', run.call_args.args[0])

    def test_script_crash_is_an_error_with_its_output(self):
        result, _, _ = self.run_process(FakeProcess(stderr='Traceback\nImportError: cv2'))
        self.assertEqual(result['resultado'], 'error')
        self.assertIn('ImportError', result['detalle'])

    def test_corrections_are_counted_and_logged(self):
        result = {
            'resultado': 'corregida',
            'antes': {'pan': -12.0, 'tilt': -62.0, 'zoom': 0.0},
            'despues': {'pan': -40.0, 'tilt': -62.0, 'zoom': 0.0},
            'referencia': {'pan': -40.0, 'tilt': -62.0, 'zoom': 0.0},
        }
        CAPTURE_SERVICE._record_encuadre(result)
        CAPTURE_SERVICE._record_encuadre(result)
        stats = CAPTURE_SERVICE._stats
        self.assertEqual(stats['encuadre_estado'], 'ok')
        self.assertEqual(stats['encuadre_correcciones_hoy'], 2)
        self.assertIsNotNone(stats['encuadre_ultima_correccion_at'])
        message = CAPTURE_SERVICE._log_encuadre.call_args.args[0]
        self.assertIn('corrected', message)
        self.assertIn('pan -12', message)

    def test_repeated_ok_is_logged_once(self):
        ok = {'resultado': 'ok', 'posicion': {'pan': -40.0, 'tilt': -62.0, 'zoom': 0.0}}
        for _ in range(3):
            CAPTURE_SERVICE._record_encuadre(ok)
        self.assertEqual(CAPTURE_SERVICE._log_encuadre.call_count, 1)

    def test_not_returning_is_its_own_state(self):
        CAPTURE_SERVICE._record_encuadre({'resultado': 'no_vuelve', 'antes': {}, 'despues': {}, 'referencia': {}})
        self.assertEqual(CAPTURE_SERVICE._stats['encuadre_estado'], 'no_vuelve')

    def test_web_pages_cannot_move_or_save_the_framing(self):
        handler = CAPTURE_SERVICE.CaptureHandler.__new__(CAPTURE_SERVICE.CaptureHandler)
        handler.headers = {'Origin': 'https://moden.up.railway.app'}
        errors = []
        handler.send_error = lambda code, message=None: errors.append(code)
        action = unittest.mock.Mock()
        handler._handle_encuadre(action)
        self.assertEqual(errors, [403])
        action.assert_not_called()

    def test_local_script_can_save(self):
        handler = CAPTURE_SERVICE.CaptureHandler.__new__(CAPTURE_SERVICE.CaptureHandler)
        handler.headers = {}
        sent = []
        handler._respond_json = lambda status, payload, restricted=False: sent.append((status, payload))
        handler._handle_encuadre(lambda: {'resultado': 'guardada'})
        self.assertEqual(sent, [(200, {'resultado': 'guardada'})])


class EncuadreConfigTests(unittest.TestCase):
    def test_section_is_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            ini = Path(tmp) / 'config.ini'
            ini.write_text(
                '[encuadre]\nenabled = false\ndir = D:/x\ninterval_minutes = 2\n',
                encoding='utf-8',
            )
            config = CAPTURE_SERVICE.Config(ini)
        self.assertFalse(config.encuadre_enabled)
        self.assertEqual(config.encuadre_dir, Path('D:/x'))
        self.assertEqual(config.encuadre_interval_minutes, 2.0)
        self.assertEqual(config.encuadre_idle_interval_minutes, 30.0)

    def test_defaults_keep_the_position_outside_the_mirrored_folder(self):
        config = CAPTURE_SERVICE.Config(Path('no-existe.ini'))
        self.assertTrue(config.encuadre_enabled)
        self.assertEqual(config.encuadre_dir, Path('C:/moden/encuadre'))


if __name__ == '__main__':
    unittest.main()
