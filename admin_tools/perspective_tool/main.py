from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional

import cv2
from PySide6.QtCore import Qt, QDate, QThreadPool, QTime
from PySide6.QtGui import QIcon
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QDateEdit,
    QFileDialog,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QProgressBar,
    QPushButton,
    QSpinBox,
    QSplitter,
    QStatusBar,
    QTabWidget,
    QTextEdit,
    QTimeEdit,
    QVBoxLayout,
    QWidget,
)

from calibration_io import (
    Calibration,
    default_output_size_from_corners,
    load_calibration,
    save_calibration,
)
from calibration_widget import CalibrationCanvas, CalibrationPreview
from timelapse import (
    TimelapseRunner,
    enumerate_images,
    ffmpeg_available,
)
from warp import BatchWarpRunner, default_worker_count, sibling_output_dir


JSON_FILTER = "Calibración (*.json)"
IMAGE_FILTER = "Imágenes (*.jpg *.jpeg *.png)"
APP_USER_MODEL_ID = "moden.perspective_tool"


def _resource_path(rel: str) -> Path:
    """Resuelve una ruta relativa tanto en dev como dentro de un bundle PyInstaller."""
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).parent))
    return base / rel


ICON_PATH = _resource_path("assets/icon.ico")


class AppState:
    def __init__(self) -> None:
        self.calib: Calibration = Calibration()
        self.calib_path: Optional[Path] = None
        self.image_bgr = None
        self.image_path: Optional[Path] = None


# =============================================================================
# Pestaña 1: Calibración
# =============================================================================
class CalibrationTab(QWidget):
    def __init__(self, state: AppState, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.state = state

        self.canvas = CalibrationCanvas()
        self.preview = CalibrationPreview()

        splitter = QSplitter(Qt.Horizontal)
        splitter.addWidget(self.canvas)
        splitter.addWidget(self.preview)
        splitter.setStretchFactor(0, 1)
        splitter.setStretchFactor(1, 1)
        splitter.setSizes([10000, 10000])

        self.lbl_image = QLabel("Sin imagen")
        self.lbl_image.setStyleSheet("color: #888;")
        self.lbl_calib = QLabel("Sin calibración guardada")
        self.lbl_calib.setStyleSheet("color: #888;")

        self.spin_out_w = QSpinBox()
        self.spin_out_w.setRange(2, 10000)
        self.spin_out_w.setValue(1600)
        self.spin_out_h = QSpinBox()
        self.spin_out_h.setRange(2, 10000)
        self.spin_out_h.setValue(900)
        self.txt_name = QLineEdit()
        self.txt_name.setPlaceholderText("p. ej. fer_g1_inf1")

        out_box = QGroupBox("Tamaño de salida")
        out_layout = QHBoxLayout(out_box)
        out_layout.addWidget(QLabel("W"))
        out_layout.addWidget(self.spin_out_w)
        out_layout.addWidget(QLabel("H"))
        out_layout.addWidget(self.spin_out_h)
        btn_fit = QPushButton("Ajustar al trapecio")
        btn_fit.clicked.connect(self._fit_output_to_corners)
        out_layout.addWidget(btn_fit)
        out_layout.addStretch(1)

        # Botones de Guardar (los de cargar siguen arriba en la toolbar).
        self.btn_save_as = QPushButton("Guardar como…")
        self.btn_save_as.setMinimumHeight(28)
        self.btn_save = QPushButton("Guardar")
        self.btn_save.setMinimumHeight(28)
        self.btn_save.setEnabled(False)
        self.btn_save_as.clicked.connect(self._on_save_as)
        self.btn_save.clicked.connect(self._on_save)

        meta_box = QGroupBox("Calibración")
        meta_layout = QVBoxLayout(meta_box)
        name_row = QHBoxLayout()
        name_row.addWidget(QLabel("Nombre de la calibración:"))
        name_row.addWidget(self.txt_name, stretch=1)
        name_row.addSpacing(12)
        name_row.addWidget(self.btn_save_as)
        name_row.addWidget(self.btn_save)
        meta_layout.addLayout(name_row)
        meta_layout.addWidget(self.lbl_calib)

        # Toolbar superior solo con las acciones de "abrir".
        self.btn_load_image = QPushButton("Cargar imagen…")
        self.btn_load_image.setMinimumHeight(32)
        self.btn_load_calib = QPushButton("Cargar calibración…")
        self.btn_load_calib.setMinimumHeight(32)

        self.btn_load_image.clicked.connect(self._on_load_image)
        self.btn_load_calib.clicked.connect(self._on_load_calibration)

        toolbar = QHBoxLayout()
        toolbar.addWidget(self.btn_load_image)
        toolbar.addSpacing(16)
        toolbar.addWidget(self.btn_load_calib)
        toolbar.addStretch(1)

        layout = QVBoxLayout(self)
        layout.addLayout(toolbar)
        layout.addWidget(splitter, stretch=1)
        layout.addWidget(self.lbl_image)
        layout.addWidget(out_box)
        layout.addWidget(meta_box)

        # Wiring
        self.canvas.cornersChanged.connect(self._on_corners_changed)
        self.canvas.resetRequested.connect(self._on_new_calibration)
        self.spin_out_w.valueChanged.connect(self._on_output_size_changed)
        self.spin_out_h.valueChanged.connect(self._on_output_size_changed)

    # ---- helpers ---------------------------------------------------------
    def _refresh_active_label(self) -> None:
        if self.state.calib_path:
            self.lbl_calib.setText(f"Activa: {self.state.calib_path}")
            self.lbl_calib.setStyleSheet("color: #34c759;")
            self.btn_save.setEnabled(True)
        else:
            self.lbl_calib.setText("Sin calibración guardada")
            self.lbl_calib.setStyleSheet("color: #888;")
            self.btn_save.setEnabled(False)

    def _push_calib_to_canvas(self) -> None:
        if self.canvas.has_image():
            self.canvas.set_corners(self.state.calib.corners)
        self.spin_out_w.blockSignals(True)
        self.spin_out_h.blockSignals(True)
        self.spin_out_w.setValue(self.state.calib.output_size[0])
        self.spin_out_h.setValue(self.state.calib.output_size[1])
        self.spin_out_w.blockSignals(False)
        self.spin_out_h.blockSignals(False)
        self.txt_name.setText(self.state.calib.name)
        self._update_preview()

    def _update_preview(self) -> None:
        if self.state.image_bgr is None:
            self.preview.clear()
            return
        self.preview.update_preview(self.state.image_bgr, self.state.calib)

    # ---- handlers --------------------------------------------------------
    def _on_load_image(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "Cargar imagen", "", IMAGE_FILTER
        )
        if not path:
            return
        img = cv2.imread(path)
        if img is None:
            QMessageBox.warning(self, "Error", f"No se pudo abrir:\n{path}")
            return
        h, w = img.shape[:2]
        self.state.image_bgr = img
        self.state.image_path = Path(path)
        self.state.calib.source_size = (w, h)
        if self.state.calib.corners == [0] * 8:
            margin_x = w // 6
            margin_y = h // 6
            self.state.calib.corners = [
                margin_x, margin_y,
                w - margin_x, margin_y,
                margin_x, h - margin_y,
                w - margin_x, h - margin_y,
            ]
            self.state.calib.output_size = default_output_size_from_corners(
                self.state.calib.corners
            )

        self.canvas.set_image(img)
        self._push_calib_to_canvas()
        self.lbl_image.setText(f"Imagen: {path} ({w}×{h})")

    def _on_new_calibration(self) -> None:
        if self.state.image_bgr is None:
            QMessageBox.information(self, "Info", "Primero carga una imagen")
            return
        h, w = self.state.image_bgr.shape[:2]
        margin_x = w // 6
        margin_y = h // 6
        self.state.calib = Calibration(
            corners=[
                margin_x, margin_y,
                w - margin_x, margin_y,
                margin_x, h - margin_y,
                w - margin_x, h - margin_y,
            ],
            source_size=(w, h),
            output_size=(w - 2 * margin_x, h - 2 * margin_y),
            name="",
        )
        self.state.calib_path = None
        self._push_calib_to_canvas()
        self._refresh_active_label()

    def _on_corners_changed(self) -> None:
        self.state.calib.corners = self.canvas.get_corners()
        self._update_preview()

    def _on_output_size_changed(self) -> None:
        self.state.calib.output_size = (
            int(self.spin_out_w.value()),
            int(self.spin_out_h.value()),
        )
        self._update_preview()

    def _fit_output_to_corners(self) -> None:
        w, h = default_output_size_from_corners(self.state.calib.corners)
        self.spin_out_w.setValue(w)
        self.spin_out_h.setValue(h)

    def _on_load_calibration(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "Cargar calibración", "", JSON_FILTER
        )
        if not path:
            return
        try:
            calib = load_calibration(path)
        except Exception as exc:
            QMessageBox.warning(self, "Error", f"No se pudo cargar:\n{exc}")
            return
        self.state.calib = calib
        self.state.calib_path = Path(path)
        self._push_calib_to_canvas()
        self._refresh_active_label()

    def _on_save_as(self) -> None:
        self.state.calib.name = self.txt_name.text().strip()

        suggested_name = self.state.calib.name or "calibracion"
        if self.state.calib_path:
            base_dir = self.state.calib_path.parent
        elif self.state.image_path:
            base_dir = self.state.image_path.parent
        else:
            base_dir = Path.cwd()
        suggested_path = str(base_dir / f"{suggested_name}.json")

        path, _ = QFileDialog.getSaveFileName(
            self, "Guardar calibración como…", suggested_path, JSON_FILTER
        )
        if not path:
            return
        if not path.lower().endswith(".json"):
            path += ".json"
        try:
            save_calibration(path, self.state.calib)
        except Exception as exc:
            QMessageBox.warning(self, "Error", f"No se pudo guardar:\n{exc}")
            return
        self.state.calib_path = Path(path)
        self._refresh_active_label()

    def _on_save(self) -> None:
        if not self.state.calib_path:
            self._on_save_as()
            return
        self.state.calib.name = self.txt_name.text().strip()
        try:
            save_calibration(self.state.calib_path, self.state.calib)
        except Exception as exc:
            QMessageBox.warning(self, "Error", f"No se pudo guardar:\n{exc}")
            return
        self._refresh_active_label()


# =============================================================================
# Pestaña 2: Procesar lote
# =============================================================================
class BatchTab(QWidget):
    def __init__(self, state: AppState, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.state = state
        self._runner: Optional[BatchWarpRunner] = None
        self.pool = QThreadPool.globalInstance()

        self.txt_input = QLineEdit()
        self.txt_input.setPlaceholderText("Carpeta con .jpg (p. ej. G:\\Mi unidad\\capturas_moden\\<mesa>\\YYYY-MM-DD)")
        self.txt_output = QLineEdit()
        self.txt_output.setReadOnly(True)
        self.txt_output.setPlaceholderText("Se calcula automáticamente: <carpeta>_rect")

        btn_browse = QPushButton("Examinar…")
        btn_browse.clicked.connect(self._browse_input)

        in_row = QHBoxLayout()
        in_row.addWidget(QLabel("Entrada:"))
        in_row.addWidget(self.txt_input, stretch=1)
        in_row.addWidget(btn_browse)

        out_row = QHBoxLayout()
        out_row.addWidget(QLabel("Salida:"))
        out_row.addWidget(self.txt_output, stretch=1)

        self.lbl_calib = QLabel("Sin calibración activa")
        self.lbl_calib.setStyleSheet("color: #888;")

        self.btn_load_calib = QPushButton("Usar otra calibración…")
        self.btn_load_calib.clicked.connect(self._load_other_calibration)

        calib_row = QHBoxLayout()
        calib_row.addWidget(QLabel("Calibración:"))
        calib_row.addWidget(self.lbl_calib, stretch=1)
        calib_row.addWidget(self.btn_load_calib)

        self.spin_workers = QSpinBox()
        self.spin_workers.setRange(1, 32)
        self.spin_workers.setValue(default_worker_count())
        self.spin_workers.setToolTip(
            "Cuántas imágenes procesar a la vez. Subir este número acelera, "
            "pero también usa más CPU."
        )

        workers_row = QHBoxLayout()
        workers_row.addWidget(QLabel("Hilos en paralelo:"))
        workers_row.addWidget(self.spin_workers)
        workers_row.addStretch(1)

        self.btn_run = QPushButton("Procesar")
        self.btn_run.clicked.connect(self._run)
        self.btn_cancel = QPushButton("Cancelar")
        self.btn_cancel.clicked.connect(self._cancel)
        self.btn_cancel.setEnabled(False)

        run_row = QHBoxLayout()
        run_row.addWidget(self.btn_run)
        run_row.addWidget(self.btn_cancel)
        run_row.addStretch(1)

        self.progress = QProgressBar()
        self.progress.setRange(0, 100)
        self.log = QTextEdit()
        self.log.setReadOnly(True)

        self.txt_input.textChanged.connect(self._update_output)

        layout = QVBoxLayout(self)
        layout.addLayout(in_row)
        layout.addLayout(out_row)
        layout.addLayout(calib_row)
        layout.addLayout(workers_row)
        layout.addLayout(run_row)
        layout.addWidget(self.progress)
        layout.addWidget(self.log, stretch=1)

    def _browse_input(self) -> None:
        path = QFileDialog.getExistingDirectory(self, "Carpeta con imágenes")
        if path:
            self.txt_input.setText(path)

    def _update_output(self) -> None:
        text = self.txt_input.text().strip()
        if not text:
            self.txt_output.setText("")
            return
        try:
            out = sibling_output_dir(Path(text))
            self.txt_output.setText(str(out))
        except Exception:
            self.txt_output.setText("")

    def refresh_active_calibration(self) -> None:
        if self.state.calib_path:
            self.lbl_calib.setText(f"Activa: {self.state.calib_path}")
            self.lbl_calib.setStyleSheet("color: #34c759;")
        elif self.state.calib.corners != [0] * 8:
            self.lbl_calib.setText("En memoria (sin guardar)")
            self.lbl_calib.setStyleSheet("color: #ffcc00;")
        else:
            self.lbl_calib.setText("Sin calibración activa")
            self.lbl_calib.setStyleSheet("color: #888;")

    def _load_other_calibration(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "Cargar calibración", "", JSON_FILTER
        )
        if not path:
            return
        try:
            calib = load_calibration(path)
        except Exception as exc:
            QMessageBox.warning(self, "Error", f"No se pudo cargar:\n{exc}")
            return
        self.state.calib = calib
        self.state.calib_path = Path(path)
        self.refresh_active_calibration()

    def _run(self) -> None:
        if not self.txt_input.text().strip():
            QMessageBox.information(self, "Info", "Selecciona una carpeta de entrada")
            return
        if self.state.calib.corners == [0] * 8:
            QMessageBox.information(
                self, "Info",
                "No hay calibración activa. Crea o carga una en la pestaña 'Calibración'.",
            )
            return

        in_dir = Path(self.txt_input.text().strip())
        if not in_dir.is_dir():
            QMessageBox.warning(self, "Error", f"No existe:\n{in_dir}")
            return
        out_dir = sibling_output_dir(in_dir)

        self._runner = BatchWarpRunner(
            in_dir, out_dir, self.state.calib, workers=self.spin_workers.value()
        )
        self._runner.signals.progress.connect(self._on_progress)
        self._runner.signals.log.connect(self._append_log)
        self._runner.signals.finished.connect(self._on_finished)

        self.log.clear()
        self.progress.setValue(0)
        self.btn_run.setEnabled(False)
        self.btn_cancel.setEnabled(True)
        self._append_log(f"Entrada: {in_dir}")
        self.pool.start(self._runner)

    def _cancel(self) -> None:
        if self._runner:
            self._runner.cancel()
            self._append_log("Solicitud de cancelación enviada…")

    def _on_progress(self, done: int, total: int) -> None:
        if total <= 0:
            self.progress.setValue(0)
            return
        self.progress.setValue(int(done * 100 / total))

    def _append_log(self, line: str) -> None:
        self.log.append(line)

    def _on_finished(self, ok: int, skipped: int, errors: int) -> None:
        self.btn_run.setEnabled(True)
        self.btn_cancel.setEnabled(False)
        self._append_log(
            f"Terminado: ok={ok}, saltadas={skipped}, errores={errors}"
        )
        self._runner = None


# =============================================================================
# Pestaña 3: Timelapse
# =============================================================================
class TimelapseTab(QWidget):
    def __init__(self, state: AppState, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.state = state
        self._runner: Optional[TimelapseRunner] = None
        self.pool = QThreadPool.globalInstance()

        self.txt_folder = QLineEdit()
        self.txt_folder.setPlaceholderText("Carpeta con .jpg (o con subcarpetas YYYY-MM-DD)")
        btn_browse = QPushButton("Examinar…")
        btn_browse.clicked.connect(self._browse)

        folder_row = QHBoxLayout()
        folder_row.addWidget(QLabel("Carpeta:"))
        folder_row.addWidget(self.txt_folder, stretch=1)
        folder_row.addWidget(btn_browse)

        # Filtros
        self.chk_date = QCheckBox("Filtrar por rango de fechas")
        self.date_from = QDateEdit(QDate.currentDate())
        self.date_to = QDateEdit(QDate.currentDate())
        self.date_from.setCalendarPopup(True)
        self.date_to.setCalendarPopup(True)
        self.date_from.setEnabled(False)
        self.date_to.setEnabled(False)
        self.chk_date.toggled.connect(self.date_from.setEnabled)
        self.chk_date.toggled.connect(self.date_to.setEnabled)

        date_row = QHBoxLayout()
        date_row.addWidget(self.chk_date)
        date_row.addWidget(QLabel("De"))
        date_row.addWidget(self.date_from)
        date_row.addWidget(QLabel("a"))
        date_row.addWidget(self.date_to)
        date_row.addStretch(1)

        self.chk_time = QCheckBox("Filtrar por rango de hora")
        self.time_from = QTimeEdit(QTime(8, 0))
        self.time_to = QTimeEdit(QTime(20, 0))
        self.time_from.setEnabled(False)
        self.time_to.setEnabled(False)
        self.chk_time.toggled.connect(self.time_from.setEnabled)
        self.chk_time.toggled.connect(self.time_to.setEnabled)

        time_row = QHBoxLayout()
        time_row.addWidget(self.chk_time)
        time_row.addWidget(QLabel("De"))
        time_row.addWidget(self.time_from)
        time_row.addWidget(QLabel("a"))
        time_row.addWidget(self.time_to)
        time_row.addStretch(1)

        self.spin_fps = QSpinBox()
        self.spin_fps.setRange(1, 240)
        self.spin_fps.setValue(24)
        self.spin_width = QSpinBox()
        self.spin_width.setRange(160, 7680)
        self.spin_width.setValue(1280)

        opts_row = QHBoxLayout()
        opts_row.addWidget(QLabel("FPS:"))
        opts_row.addWidget(self.spin_fps)
        opts_row.addSpacing(20)
        opts_row.addWidget(QLabel("Ancho de salida:"))
        opts_row.addWidget(self.spin_width)
        opts_row.addStretch(1)

        self.lbl_count = QLabel("Imágenes seleccionadas: —")
        self.btn_count = QPushButton("Contar imágenes")
        self.btn_count.clicked.connect(self._count_images)

        count_row = QHBoxLayout()
        count_row.addWidget(self.btn_count)
        count_row.addWidget(self.lbl_count, stretch=1)

        self.btn_run = QPushButton("Generar…")
        self.btn_run.clicked.connect(self._run)
        self.btn_cancel = QPushButton("Cancelar")
        self.btn_cancel.setEnabled(False)
        self.btn_cancel.clicked.connect(self._cancel)

        run_row = QHBoxLayout()
        run_row.addWidget(self.btn_run)
        run_row.addWidget(self.btn_cancel)
        run_row.addStretch(1)

        self.progress = QProgressBar()
        self.progress.setRange(0, 100)
        self.log = QTextEdit()
        self.log.setReadOnly(True)

        if ffmpeg_available():
            ffmpeg_msg = "ffmpeg disponible — vídeo de calidad alta (H.264)."
            ffmpeg_color = "#34c759"
        else:
            ffmpeg_msg = "ffmpeg no disponible — se usará fallback OpenCV (calidad menor)."
            ffmpeg_color = "#ffcc00"
        lbl_ffmpeg = QLabel(ffmpeg_msg)
        lbl_ffmpeg.setStyleSheet(f"color: {ffmpeg_color};")

        self.txt_folder.textChanged.connect(lambda _: self.lbl_count.setText("Imágenes seleccionadas: —"))

        layout = QVBoxLayout(self)
        layout.addLayout(folder_row)
        layout.addLayout(date_row)
        layout.addLayout(time_row)
        layout.addLayout(opts_row)
        layout.addLayout(count_row)
        layout.addWidget(lbl_ffmpeg)
        layout.addLayout(run_row)
        layout.addWidget(self.progress)
        layout.addWidget(self.log, stretch=1)

    def _browse(self) -> None:
        path = QFileDialog.getExistingDirectory(self, "Carpeta con imágenes")
        if path:
            self.txt_folder.setText(path)

    def _selected_images(self):
        text = self.txt_folder.text().strip()
        if not text:
            return []
        folder = Path(text)
        date_from = self.date_from.date().toPython() if self.chk_date.isChecked() else None
        date_to = self.date_to.date().toPython() if self.chk_date.isChecked() else None
        time_from = self.time_from.time().toPython() if self.chk_time.isChecked() else None
        time_to = self.time_to.time().toPython() if self.chk_time.isChecked() else None
        return enumerate_images(folder, date_from, date_to, time_from, time_to)

    def _count_images(self) -> None:
        imgs = self._selected_images()
        self.lbl_count.setText(f"Imágenes seleccionadas: {len(imgs)}")

    def _run(self) -> None:
        imgs = self._selected_images()
        if not imgs:
            QMessageBox.information(self, "Info", "No hay imágenes para procesar")
            return
        out_path, _ = QFileDialog.getSaveFileName(
            self, "Guardar timelapse como…", "timelapse.mp4", "Vídeo MP4 (*.mp4)"
        )
        if not out_path:
            return
        if not out_path.lower().endswith(".mp4"):
            out_path += ".mp4"

        self._runner = TimelapseRunner(
            imgs,
            Path(out_path),
            self.spin_fps.value(),
            self.spin_width.value(),
            prefer_ffmpeg=True,
        )
        self._runner.signals.progress.connect(self._on_progress)
        self._runner.signals.log.connect(lambda l: self.log.append(l))
        self._runner.signals.finished.connect(self._on_finished)

        self.log.clear()
        self.log.append(f"Generando {out_path} con {len(imgs)} imágenes a {self.spin_fps.value()} fps…")
        self.progress.setValue(0)
        self.btn_run.setEnabled(False)
        self.btn_cancel.setEnabled(True)
        self.pool.start(self._runner)

    def _cancel(self) -> None:
        if self._runner:
            self._runner.cancel()
            self.log.append("Solicitud de cancelación enviada…")

    def _on_progress(self, done: int, total: int) -> None:
        if total <= 0:
            return
        self.progress.setValue(int(done * 100 / total))

    def _on_finished(self, ok: bool, message: str) -> None:
        self.btn_run.setEnabled(True)
        self.btn_cancel.setEnabled(False)
        self.log.append(("OK: " if ok else "ERROR: ") + message)
        self._runner = None


# =============================================================================
# MainWindow
# =============================================================================
class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("Perspective Tool — capturas Moden")
        self.resize(1300, 850)
        self.state = AppState()

        self.tabs = QTabWidget()
        self.tab_calib = CalibrationTab(self.state)
        self.tab_batch = BatchTab(self.state)
        self.tab_time = TimelapseTab(self.state)

        self.tabs.addTab(self.tab_calib, "Calibración")
        self.tabs.addTab(self.tab_batch, "Procesar lote")
        self.tabs.addTab(self.tab_time, "Timelapse")

        self.tabs.currentChanged.connect(self._on_tab_changed)
        self.setCentralWidget(self.tabs)
        self.setStatusBar(QStatusBar())

    def _on_tab_changed(self, index: int) -> None:
        if self.tabs.widget(index) is self.tab_batch:
            self.tab_batch.refresh_active_calibration()


def _set_windows_app_id() -> None:
    if sys.platform != "win32":
        return
    try:
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_USER_MODEL_ID)
    except Exception:
        pass


def main() -> int:
    _set_windows_app_id()
    app = QApplication(sys.argv)
    if ICON_PATH.exists():
        app.setWindowIcon(QIcon(str(ICON_PATH)))
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
