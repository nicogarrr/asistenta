# Pedido semanal de Mercadona

Asistenta hace la compra online en **tienda.mercadona.es** con tu propia cuenta, a partir de la lista de la compra.

## Cómo funciona

1. Durante la semana dile lo que falta: «faltan huevos», «falta leche y tomate», «se ha acabado el aceite». Va a la lista (/compra).
2. El día del pedido (por defecto **viernes a las 10:00**) te escribe: «🛒 Tienes esto en la lista: … ¿Hago el pedido en Mercadona?» con **✅ Sí / ❌ No / ✏️ Editar**.
   - Cambiar el día: «el pedido de Mercadona los lunes» o «pedido de Mercadona los sábados a las 9».
   - Pedir cuando quieras: «haz el pedido de Mercadona» o «pide lo de la lista».
3. Con **Sí** busca cada cosa en tu tienda (la de tu código postal). Si hay varias parecidas te pregunta con botones y recuerda lo que elijas para la próxima vez.
4. Llena el carrito de tu cuenta y te enseña productos, precios, **total** y las **franjas de entrega** como botones.
5. Eliges franja y te enseña el resumen con **✅ Confirmar pedido**. Solo con ese botón paga, con la tarjeta que tienes guardada en tu cuenta de Mercadona, y te dice el **nº de pedido** y la franja. Si pulsas Cancelar, o algo falla, no se paga nada.

Si tu banco pide confirmar el pago en su app, apruébalo en el móvil; si la web no muestra el número de pedido, Asistenta te lo dice y no reintenta sola (mira «Mis pedidos» antes de repetir).

## Lo que tienes que hacer una vez (Windows)

1. Actualiza Asistenta: en la carpeta de Asistenta, `git pull`, luego `npm ci` y `npm run build`, y reinicia (`levantar.bat`).
2. Abre el Chrome de Asistenta (el que usa para navegar por ti; en Telegram: «abre tienda.mercadona.es»).
3. En tienda.mercadona.es **inicia sesión con tu cuenta** y comprueba que:
   - el código postal es el de tu casa,
   - tienes la **dirección de entrega** guardada,
   - tienes una **tarjeta guardada** (Mi cuenta › Métodos de pago).
4. Listo. La sesión se queda en ese Chrome; tu contraseña y el token nunca pasan por el modelo.

## Notas

- La búsqueda usa el buscador público de la web; el carrito, las franjas y el pedido usan la API interna de la web desde tu propia pestaña. Si Mercadona cambia su web, el pedido se para y te lo dice; nunca paga a ciegas: antes de pulsar comprueba que el total de la web es el que confirmaste.
- Lo que haya en el carrito de la web se sustituye por la lista al preparar el pedido.
- Los tests usan respuestas grabadas; nunca la web real.
