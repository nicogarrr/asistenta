#!/usr/bin/env python3
"""Tests sinteticos de la logica de eventos del bench A1b (objeciones de las
rondas 1-2, #139): regla unica umbral/paciencia, disparo por INSTANTE DE
TRIGGER (no por solape de toda la racha), un trigger por racha (sin rearme),
sin doble credito, warmup y fin de audio no evaluables, eventos bajo region
no evaluable ignorados (ni hits ni falsos), continuidad del timeline y
FAR = NA cuando no hay medicion. unittest de stdlib:
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


def scores_ends(pairs):
    """pairs: lista de (n_ventanas, score) desde el push 25."""
    scores, ends = [], []
    p = 25
    for n, sc in pairs:
        scores += [sc] * n
        ends += list(range(p, p + n))
        p += n
    return np.array(scores), np.array(ends)


class TestEventos(unittest.TestCase):
    def test_pico_aislado_no_es_evento_con_paciencia(self):
        scores = np.array([0.99, 0.01, 0.99, 0.01])
        ends = np.array([25, 26, 27, 28])
        self.assertEqual(bench.extract_events(scores, ends, 0.5, patience=2), [])
        eventos = bench.extract_events(scores, ends, 0.5, patience=1)
        self.assertEqual(len(eventos), 2)

    def test_trigger_es_instante_no_toda_la_racha(self):
        # canario del auditor r2: scores=1 de 25 a 124, palabra en 100 ->
        # trigger en 26: falso wake temprano + palabra perdida, NO un hit
        scores, ends = scores_ends([(100, 0.99)])
        eventos = bench.extract_events(scores, ends, 0.5, patience=2)
        self.assertEqual(len(eventos), 1)
        self.assertEqual(eventos[0][3], 26)  # trigger = start + paciencia - 1
        detected, missed, falsos, ignorados, _ = bench.assign_events(eventos, [100], [], 26)
        self.assertEqual(detected, [])
        self.assertEqual(missed, [100])
        self.assertEqual(len(falsos), 1)
        self.assertEqual(ignorados, [])

    def test_racha_activa_no_rearma_un_solo_trigger(self):
        # una racha continua que cubre DOS regiones: un solo trigger, una sola
        # deteccion posible; la otra region queda miss
        scores, ends = scores_ends([(56, 0.99)])  # pushes 25..80
        eventos = bench.extract_events(scores, ends, 0.5, patience=2)
        detected, missed, falsos, _, notas = bench.assign_events(eventos, [40, 70], [], 26)
        self.assertEqual(detected, [40])  # trigger 26 esta a 14 de 40, a 44 de 70
        self.assertEqual(missed, [70])
        self.assertEqual(falsos, [])

    def test_evento_bajo_region_no_evaluable_es_ignorado(self):
        # trigger en 30 bajo region warmup (centro 9): ni hit ni falso;
        # coherente con que 30 no esta en la exposicion negativa
        scores, ends = scores_ends([(10, 0.99), (26, 0.01)])  # 25..34 altos
        eventos = bench.extract_events(scores, ends, 0.5, patience=2)
        detected, missed, falsos, ignorados, _ = bench.assign_events(eventos, [60], [9], 26)
        self.assertEqual(detected, [])
        self.assertEqual(falsos, [])
        self.assertEqual(len(ignorados), 1)

    def test_warmup_y_fin_de_audio_no_evaluables(self):
        evaluables, no_evaluables = bench.split_regions([9, 46, 500], 25, 124)
        self.assertEqual(evaluables, [46])
        self.assertEqual(no_evaluables, [9, 500])

    def test_canario_continuidad_auditoria(self):
        # scores [.99,.1,.99] con una region en medio: los dos picos NO son
        # consecutivos en el timeline; trocear el timeline daria 1 falso wake
        # fantasma con paciencia 2. Sobre el timeline completo: 0 eventos.
        scores = np.array([0.99, 0.1, 0.99])
        ends = np.array([25, 26, 27])
        eventos = bench.extract_events(scores, ends, 0.5, patience=2)
        self.assertEqual(eventos, [])
        detected, missed, falsos, _, _ = bench.assign_events(eventos, [26], [], 1)
        self.assertEqual((detected, falsos), ([], []))
        self.assertEqual(missed, [26])

    def test_far_sin_negativos_es_na_no_cero(self):
        scores = np.array([0.1, 0.2, 0.3])
        ends = np.array([25, 26, 27])
        far, n_neg, secs = bench.far_metrics(scores, ends, [26], 26, 0.5)
        self.assertIsNone(far, "sin ventanas expuestas no hay medicion: NA, no 0.0")
        self.assertEqual(n_neg, 0)
        self.assertEqual(secs, 0.0)

    def test_region_detectada_requiere_evento_no_pico(self):
        scores = np.array([0.01, 0.99, 0.01])
        ends = np.array([25, 26, 27])
        eventos = bench.extract_events(scores, ends, 0.5, patience=2)
        detected, missed, _, _, _ = bench.assign_events(eventos, [26], [], 1)
        self.assertEqual(detected, [])
        self.assertEqual(missed, [26])

    def test_doble_credito_imposible_con_dos_eventos(self):
        # dos eventos distintos pueden detectar dos regiones; uno solo no
        scores, ends = scores_ends([(3, 0.99), (10, 0.01), (3, 0.99), (5, 0.01)])
        eventos = bench.extract_events(scores, ends, 0.5, patience=2)
        detected, missed, falsos, _, _ = bench.assign_events(eventos, [26, 39], [], 4)
        self.assertEqual(detected, [26, 39])
        self.assertEqual(falsos, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
