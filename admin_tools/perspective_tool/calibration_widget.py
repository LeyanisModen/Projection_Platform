from __future__ import annotations

from typing import List, Optional

import cv2
import numpy as np
from PySide6.QtCore import Qt, QPointF, QRectF, Signal
from PySide6.QtGui import (
    QBrush,
    QColor,
    QImage,
    QKeyEvent,
    QPainter,
    QPen,
    QPixmap,
    QWheelEvent,
)
from PySide6.QtWidgets import (
    QFrame,
    QGraphicsEllipseItem,
    QGraphicsItem,
    QGraphicsLineItem,
    QGraphicsPixmapItem,
    QGraphicsScene,
    QGraphicsSimpleTextItem,
    QGraphicsView,
    QLabel,
    QPushButton,
    QSizePolicy,
    QStyle,
    QVBoxLayout,
    QWidget,
)

from calibration_io import Calibration
from warp import apply_warp


CORNER_RADIUS = 9
CORNER_COLORS = (
    QColor("#ff3b30"),  # TL red
    QColor("#34c759"),  # TR green
    QColor("#007aff"),  # BL blue
    QColor("#ffcc00"),  # BR yellow
)
CORNER_ARROWS = ("↖", "↗", "↙", "↘")
# Offsets en píxeles del label respecto al centro del punto, hacia el exterior.
# (dx, dy) en coordenadas de pantalla — el item ignora las transformaciones
# del view, así que estos píxeles son siempre constantes.
CORNER_LABEL_OFFSETS = (
    (-22, -22),  # TL: arriba-izquierda
    (10, -22),   # TR: arriba-derecha
    (-22, 8),    # BL: abajo-izquierda
    (10, 8),     # BR: abajo-derecha
)


def bgr_to_qpixmap(bgr: np.ndarray) -> QPixmap:
    if bgr.ndim == 2:
        rgb = cv2.cvtColor(bgr, cv2.COLOR_GRAY2RGB)
    else:
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    h, w = rgb.shape[:2]
    qimg = QImage(rgb.data, w, h, 3 * w, QImage.Format_RGB888).copy()
    return QPixmap.fromImage(qimg)


class CornerItem(QGraphicsEllipseItem):
    def __init__(self, index: int, on_change) -> None:
        d = CORNER_RADIUS * 2
        super().__init__(-CORNER_RADIUS, -CORNER_RADIUS, d, d)
        self.index = index
        self._on_change = on_change
        self.setBrush(QBrush(CORNER_COLORS[index]))
        self.setPen(QPen(QColor("white"), 2))
        self.setFlags(
            QGraphicsItem.ItemIsMovable
            | QGraphicsItem.ItemIsSelectable
            | QGraphicsItem.ItemSendsGeometryChanges
            | QGraphicsItem.ItemIgnoresTransformations
        )
        self.setZValue(10)
        self.label = QGraphicsSimpleTextItem(CORNER_ARROWS[index], parent=self)
        font = self.label.font()
        font.setPointSize(11)
        font.setBold(True)
        self.label.setFont(font)
        self.label.setBrush(QBrush(QColor("white")))
        dx, dy = CORNER_LABEL_OFFSETS[index]
        self.label.setPos(dx, dy)
        self.label.setFlag(QGraphicsItem.ItemIgnoresTransformations, True)

    def itemChange(self, change, value):
        if change == QGraphicsItem.ItemPositionHasChanged:
            self._on_change(self.index, value)
        return super().itemChange(change, value)


class CalibrationCanvas(QGraphicsView):
    cornersChanged = Signal()
    resetRequested = Signal()

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self._scene = QGraphicsScene(self)
        self.setScene(self._scene)
        self.setRenderHints(
            QPainter.Antialiasing | QPainter.SmoothPixmapTransform
        )
        self.setTransformationAnchor(QGraphicsView.AnchorUnderMouse)
        self.setDragMode(QGraphicsView.NoDrag)
        self.setBackgroundBrush(QBrush(QColor("#1e1e1e")))
        self.setFrameShape(QFrame.NoFrame)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.setViewportMargins(0, 0, 0, 0)
        self.setContentsMargins(0, 0, 0, 0)
        self.setMinimumSize(400, 300)

        self._pixmap_item: Optional[QGraphicsPixmapItem] = None
        self._corner_items: List[CornerItem] = []
        self._line_items: List[QGraphicsLineItem] = []
        self._image_size = (0, 0)
        self._suppress = False
        self._selected_index: int = 0

        # Botón flotante de reset, hijo del view (no de la scene) para que
        # quede siempre en una esquina aunque la imagen se haga zoom/pan.
        self._btn_reset = QPushButton("Reiniciar trapecio", self)
        self._btn_reset.setToolTip("Vuelve a colocar los 4 puntos en una caja por defecto")
        self._btn_reset.setIcon(self.style().standardIcon(QStyle.SP_BrowserReload))
        self._btn_reset.setCursor(Qt.PointingHandCursor)
        self._btn_reset.setStyleSheet(
            "QPushButton {"
            "  background-color: #2d2d30;"
            "  color: #f0f0f0;"
            "  border: 1px solid #555;"
            "  border-radius: 4px;"
            "  padding: 4px 10px;"
            "}"
            "QPushButton:hover { background-color: #3e3e42; border-color: #777; }"
            "QPushButton:pressed { background-color: #1e1e1e; }"
            "QPushButton:disabled { color: #777; border-color: #444; }"
        )
        self._btn_reset.clicked.connect(self.resetRequested)
        self._btn_reset.setEnabled(False)
        self._btn_reset.adjustSize()
        self._reposition_overlay()

    def has_image(self) -> bool:
        return self._pixmap_item is not None

    def _reposition_overlay(self) -> None:
        margin = 8
        x = self.viewport().width() - self._btn_reset.width() - margin
        y = margin
        self._btn_reset.move(max(margin, x), y)
        self._btn_reset.raise_()

    def image_size(self) -> tuple[int, int]:
        return self._image_size

    def set_image(self, bgr: np.ndarray) -> None:
        h, w = bgr.shape[:2]
        self._image_size = (w, h)
        self._scene.clear()
        self._corner_items = []
        self._line_items = []

        pix = bgr_to_qpixmap(bgr)
        self._pixmap_item = self._scene.addPixmap(pix)
        self._pixmap_item.setZValue(0)
        self._scene.setSceneRect(QRectF(0, 0, w, h))

        line_pen = QPen(QColor("#ffffff"))
        line_pen.setWidth(0)
        line_pen.setCosmetic(True)
        for _ in range(4):
            line = QGraphicsLineItem()
            line.setPen(line_pen)
            line.setZValue(5)
            self._scene.addItem(line)
            self._line_items.append(line)

        for i in range(4):
            ci = CornerItem(i, self._on_corner_moved)
            self._scene.addItem(ci)
            self._corner_items.append(ci)

        self._btn_reset.setEnabled(True)
        self._reposition_overlay()
        self.fit_to_view()

    def fit_to_view(self) -> None:
        if self._pixmap_item is None:
            return
        self.fitInView(self._pixmap_item, Qt.KeepAspectRatio)

    def set_corners(self, corners: List[int]) -> None:
        if not self._corner_items:
            return
        self._suppress = True
        try:
            for i in range(4):
                x = corners[i * 2]
                y = corners[i * 2 + 1]
                self._corner_items[i].setPos(QPointF(x, y))
        finally:
            self._suppress = False
        self._update_lines()

    def get_corners(self) -> List[int]:
        out: List[int] = []
        for ci in self._corner_items:
            p = ci.pos()
            out.extend([int(round(p.x())), int(round(p.y()))])
        return out

    def _on_corner_moved(self, index: int, new_pos: QPointF) -> None:
        self._selected_index = index
        if self._suppress:
            return
        self._update_lines()
        self.cornersChanged.emit()

    def _update_lines(self) -> None:
        if not self._corner_items or len(self._line_items) != 4:
            return
        # Order on screen: TL → TR → BR → BL → TL
        order = [0, 1, 3, 2, 0]
        for i in range(4):
            a = self._corner_items[order[i]].pos()
            b = self._corner_items[order[i + 1]].pos()
            self._line_items[i].setLine(a.x(), a.y(), b.x(), b.y())

    def wheelEvent(self, event: QWheelEvent) -> None:
        if self._pixmap_item is None:
            return super().wheelEvent(event)
        factor = 1.15 if event.angleDelta().y() > 0 else 1 / 1.15
        self.scale(factor, factor)

    def keyPressEvent(self, event: QKeyEvent) -> None:
        if not self._corner_items:
            return super().keyPressEvent(event)

        deltas = {
            Qt.Key_Left: (-1, 0),
            Qt.Key_Right: (1, 0),
            Qt.Key_Up: (0, -1),
            Qt.Key_Down: (0, 1),
        }
        if event.key() in deltas:
            dx, dy = deltas[event.key()]
            ci = self._corner_items[self._selected_index]
            p = ci.pos()
            ci.setPos(QPointF(p.x() + dx, p.y() + dy))
            event.accept()
            return
        super().keyPressEvent(event)

    def mousePressEvent(self, event):
        item = self.itemAt(event.pos())
        if isinstance(item, CornerItem):
            self._selected_index = item.index
        elif item and item.parentItem() and isinstance(item.parentItem(), CornerItem):
            self._selected_index = item.parentItem().index
        super().mousePressEvent(event)

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self._reposition_overlay()


class CalibrationPreview(QWidget):
    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        self.label = QLabel("Carga una imagen para ver el preview")
        self.label.setAlignment(Qt.AlignCenter)
        self.label.setFrameShape(QFrame.NoFrame)
        self.label.setStyleSheet("background-color: #1e1e1e; color: #888;")
        self.label.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.label.setMinimumSize(200, 150)
        layout.addWidget(self.label)
        self._last_pix: Optional[QPixmap] = None

    def clear(self) -> None:
        self._last_pix = None
        self.label.setText("Carga una imagen para ver el preview")
        self.label.setPixmap(QPixmap())

    def update_preview(self, image: np.ndarray, calib: Calibration) -> None:
        try:
            warped = apply_warp(image, calib)
        except Exception as exc:
            self.label.setPixmap(QPixmap())
            self.label.setText(f"Preview no disponible:\n{exc}")
            return
        self._last_pix = bgr_to_qpixmap(warped)
        self._render()

    def _render(self) -> None:
        if self._last_pix is None:
            return
        scaled = self._last_pix.scaled(
            self.label.size(),
            Qt.KeepAspectRatio,
            Qt.SmoothTransformation,
        )
        self.label.setPixmap(scaled)

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self._render()
