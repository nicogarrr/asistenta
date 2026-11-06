/**
 * /voz: el iPhone graba en audio/mp4 (AAC) o webm/opus, según la versión de iOS, y en el
 * PC eso solo se lee con ffmpeg. Si ffmpeg falta, el antivirus no le deja arrancar o
 * tarda, la nota fallaba con el error genérico de whisper. El propio móvil ya sabe
 * decodificar lo que graba (WebAudio `decodeAudioData`), así que la página lo convierte
 * a WAV mono de 16 kHz (lo que whisper usa) y el PC lo lee en JavaScript, sin ffmpeg.
 *
 * Es JavaScript de navegador en texto: va tal cual dentro de la página y los tests lo
 * ejecutan igual, así que lo probado es lo mismo que corre en el iPhone.
 */
export const VOZ_WAV_JS = `function wavMono16k(canales, rate) {
  var n = canales.length ? canales[0].length : 0;
  var salida = 16000;
  var largo = Math.max(0, Math.floor((n * salida) / rate));
  var paso = rate / salida;
  var datos = new DataView(new ArrayBuffer(44 + largo * 2));
  function texto(o, t) { for (var k = 0; k < t.length; k++) datos.setUint8(o + k, t.charCodeAt(k)); }
  texto(0, 'RIFF'); datos.setUint32(4, 36 + largo * 2, true); texto(8, 'WAVE');
  texto(12, 'fmt '); datos.setUint32(16, 16, true); datos.setUint16(20, 1, true);
  datos.setUint16(22, 1, true); datos.setUint32(24, salida, true); datos.setUint32(28, salida * 2, true);
  datos.setUint16(32, 2, true); datos.setUint16(34, 16, true);
  texto(36, 'data'); datos.setUint32(40, largo * 2, true);
  for (var i = 0; i < largo; i++) {
    var pos = i * paso, a = Math.floor(pos), f = pos - a, s = 0;
    for (var c = 0; c < canales.length; c++) {
      var x = canales[c], v0 = x[a] || 0, v1 = a + 1 < n ? x[a + 1] : v0;
      s += v0 + (v1 - v0) * f;
    }
    s = s / (canales.length || 1);
    if (s > 1) s = 1; else if (s < -1) s = -1;
    datos.setInt16(44 + i * 2, s < 0 ? s * 32768 : s * 32767, true);
  }
  return datos.buffer;
}`;
