#!/usr/bin/env python3
"""Tests sinteticos de la logica de eventos del bench A1b (objeciones 1 y 2,
ronda 1 #139): misma regla umbral/paciencia para positivos y negativos,
sin doble credito entre regiones, warmup reportado, continuidad del timeline
y FAR = NA cuando no hay medicion. unittest de stdlib, sin dependencias:
  python scripts/wakeword-farfrr-events-test.py
"""
import importlib.util
import sys
import unittest
from pathlib import Path

import numpy as np

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("bench", HERE / "wakeword-farfrr-bench.py")
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)


class TestEventos(unittest.TestCase):
    def test_pico_aislado_no_es_evento_con_paciencia(self):
        scores = np.array([0.99, 0.01, 0.99, 0.01])
        ends = np.array([25, 26, 27, 28])
        self.assertEqual(bench.extract_events(scores, ends, 0.5, patience=2), [])
        eventos = bench.extract_events(scores, ends, 0.5, patience=1)
        self.assertEqual(len(eventos), 2)  # con paciencia 1 si son eventos

    def test_dos_regiones_un_evento_no_da_doble_credito(self):
        # un unico evento en 25-35, regiones centradas en 9 y 21 con tol 26
        scores = np.concatenate([np.full(11, 0.99), np.full(20, 0.01)])
        ends = np.arange(25, 56)
        eventos = bench.extract_events(scores, ends, 0.5, patience=2)
        self.assertEqual(len(eventos), 1)
        detected, missed, falsos, notas = bench.assign_events(eventos, [9, 21], 26)
        self.assertEqual(len(detected), 1, "un evento solo puede detectar una region")
        self.assertEqual(len(missed), 1)
        self.assertEqual(falsos, [])

    def test_warmup_marca_regiones_no_evaluables(self):
        evaluables, no_evaluables = bench.split_regions([9, 21, 46], 25)
        self.assertEqual(no_evaluables, [9, 21])
        self.assertEqual(evaluables, [46])

    def test_canario_continuidad_auditoria(self):
        # scores [.99,.1,.99] con una region en medio: los dos picos NO son
        # consecutivos en el timeline; trocear el timeline daria 1 falso wake
        # fantasma con paciencia 2. Sobre el timeline completo: 0 eventos.
        scores = np.array([0.99, 0.1, 0.99])
        ends = np.array([25, 26, 27])
        eventos = bench.extract_events(scores, ends, 0.5, patience=2)
        self.assertEqual(eventos, [])
        detected, missed, falsos, _ = bench.assign_events(eventos, [26], 1)
        self.assertEqual(falsos, [])
        self.assertEqual(detected, [])
        self.assertEqual(missed, [26])

    def test_far_sin_negativos_es_na_no_cero(self):
        scores = np.array([0.1, 0.2, 0.3])
        ends = np.array([25, 26, 27])
        far, n_neg, secs = bench.far_metrics(scores, ends, [26], 26, 0.5)
        self.assertIsNone(far, "sin ventanas negativas no hay medicion: NA, no 0.0")
        self.assertEqual(n_neg, 0)
        self.assertEqual(secs, 0.0)

    def test_region_detectada_requiere_evento_no_pico(self):
        # un pico aislado dentro de la region no basta con paciencia 2:
        # es la misma regla que para los falsos wakes
        scores = np.array([0.01, 0.99, 0.01])
        ends = np.array([25, 26, 27])
        eventos = bench.extract_events(scores, ends, 0.5, patience=2)
        detected, missed, _, _ = bench.assign_events(eventos, [26], 1)
        self.assertEqual(detected, [])
        self.assertEqual(missed, [26])


if __name__ == "__main__":
    unittest.main(verbosity=2)
