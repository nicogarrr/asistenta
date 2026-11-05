/**
 * Opciones de sesión de onnxruntime para todo lo que Asistenta ejecuta en local (whisper
 * de la palabra de activación y de las notas de voz, VAD, embeddings de memoria).
 *
 * Por defecto onnxruntime deja sus hilos «girando» (espera activa) entre operación y
 * operación para arañar unos microsegundos: CPU quemada sin hacer nada. Medido con
 * whisper-small (la palabra de activación, una pasada de 3 s de audio, 16 núcleos):
 * 4,3 s → 3,0 s de CPU por pasada (−31 %) con el mismo tiempo real (0,60 → 0,62 s) y
 * exactamente el mismo resultado (mismo modelo, mismas cuentas). Con ruido en la sala
 * (tele, música) la palabra de activación hace una pasada cada ~1,5 s.
 */
export const ORT_SIN_ESPERA_ACTIVA = {
  extra: { session: { intra_op: { allow_spinning: '0' }, inter_op: { allow_spinning: '0' } } },
} as const;
