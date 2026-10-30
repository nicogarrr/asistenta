# /recordatorios

Los recordatorios se crean hablando («recuérdame mañana a las 9 llamar al dentista»). Para
verlos y quitarlos sin pasar por el modelo (sin gastar tokens):

- `/recordatorios`: lista numerada de los recordatorios de este chat, ordenada por la próxima
  vez que suenan, con fecha local («vie 31/10 09:00 (en 21 h)») y si se repiten.
- `/recordatorios borrar <número o palabra>`: borra uno. Con una palabra que aparece en varios,
  no borra nada y pide el número. Alias: `cancelar`, `quitar`, `del`; comando `/reminders`.
