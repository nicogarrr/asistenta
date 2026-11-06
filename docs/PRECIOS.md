# Vigilante de errores de precio — Amazon.es

Asistenta barre Amazon.es cada 30 minutos y te avisa por Telegram cuando un producto cuesta
**un 70 % o más por debajo de una referencia fiable** y la ficha del producto lo confirma.

## Encenderlo

Viene **encendido**. Solo necesitas:

1. `git pull`, `npm ci`, `npm run build` y reiniciar Asistenta.
2. La primera vez que haya un candidato, Asistenta abre la ficha en su Chrome. Si te pregunta
   «¿Abro amazon.es?», pulsa **Siempre**. No hace falta iniciar sesión en Amazon (si la tienes
   iniciada en ese Chrome, mejor: ve tu dirección y tus precios).
3. En Telegram: `/precios` para ver el estado.

Apagar: `/precios off` (o `PA_PRECIOS=0` en el `.env`). Encender: `/precios on`.
Barrer ya: `/precios ahora`.

## Qué barre

Por categoría (por defecto: informática, electrónica, grandes electrodomésticos, hogar y cocina,
videojuegos, juguetes, deportes, bricolaje, belleza, bebé, bebidas/licores y relojes inteligentes —este por
búsqueda—), tres listados: «Los más vendidos»,
«Los que más suben» y las novedades de la búsqueda. Cada barrido lee 6 páginas (rotando), con
6–12 s entre petición y petición. Elegir categorías:

    PA_PRECIOS_CATEGORIAS=cocina,informatica,https://www.amazon.es/s?k=robot+aspirador

Además, un **barrido rápido** cada ~12 min (±25 %, `PA_PRECIOS_RAPIDO_MIN`) de búsquedas de
marcas y productos caros, donde un error de precio dura poco: relojes inteligentes (Apple Watch,
Galaxy Watch, Garmin, Amazfit, Huawei Watch, Pixel Watch), sobre todo informática (portátiles
gaming, MacBook, monitores, SSD NVMe, tarjetas RTX, procesadores Ryzen/Intel, iPad y tablets,
auriculares Sony/Bose/AirPods, iPhone, Galaxy S, routers mesh), y belleza y licores (ghd, Dyson,
planchas y secadores, perfumes, whisky, ginebra premium, ron añejo). Son 4 páginas por barrido
(rotando, `PA_PRECIOS_RAPIDO_PAGINAS`). Cambiarlas: `PA_PRECIOS_RAPIDAS=ghd,chivas regal|grocery,dyson`
(«no» = ninguna). Casos reales que tienen que salir: la plancha ghd Gold a 29,90 € (normal
~250 €) y el Chivas Regal Mizunara a 12,50 € (normal ~69 €), los dos vendidos por Amazon.es.

Los listados y las fichas se abren en el Chrome de Asistenta (con su sesión, Amazon pone menos
captchas). Si ese Chrome falla, lee sin navegador y no lo vuelve a intentar en 6 h; `/precios`
lo dice.

## El aviso

Por Telegram, con «🚨 ERROR DE PRECIO», el producto, el precio frente a la referencia, el −X % y
por qué, y dos botones: «🛒 Comprar ya» (mete ese producto en la cesta de un toque:
`https://www.amazon.es/gp/aws/cart/add.html?ASIN.1=<ASIN>&Quantity.1=1`; si Amazon no tiene la
sesión iniciada en ese navegador, pide entrar y luego lo añade) y «🔗 Ver en Amazon» (la ficha).
Los dos enlaces van también en el texto.

## Cuándo avisa

- **Referencia fiable** (se usa la más baja): la mediana de lo que Asistenta ya ha visto de ese
  producto (3 lecturas en más de un día); el «Precio más bajo reciente» de Amazon; o el
  «Recomendado» tachado **solo si lo vende Amazon**. Así un producto nuevo sin historial también
  puede avisar.
- **Precio ≤ 30 % de la referencia** (`PA_PRECIOS_UMBRAL=70`) y referencia de 40 € o más.
- **Verificado en la ficha**: nuevo (no reacondicionado ni de segunda mano), en stock, el mismo
  precio que en el listado (±5 %), y lo vende o lo envía Amazon.
- **Descarta**: recambios y accesorios («Kit de recambios compatible con Conga…», «Cepillos
  para…»), precios «desde»/otras ofertas, precios por unidad o kilo, y el tachado de un anuncio
  de otro producto metido en el mismo resultado (así se colaban avisos falsos).
- No repite el aviso del mismo producto en 7 días salvo que baje otro 10 %.

## Si Amazon se pone pesado

Si Amazon contesta con un captcha o un 503, el vigilante **para en seco** y espera 30 min,
luego 1 h, 2 h… hasta 6 h. `/precios` dice a qué hora vuelve a probar. Nunca insiste.

## Por qué Amazon «fallaba»

Pedida sin navegador real, la ficha de Amazon **esconde el precio** («Para ver los detalles del
producto, añádelo a la cesta»), y la búsqueda mete dentro de cada resultado anuncios de otros
productos con su propio tachado. Ahora la ficha se abre en el Chrome de Asistenta y el tachado
solo cuenta si es del propio producto.
