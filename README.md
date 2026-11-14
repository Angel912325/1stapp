# Anota PDF

Aplicación para **iPad** para leer PDFs y anotarlos con el **Apple Pencil** o con el **dedo**.
Es una app web instalable (PWA): se abre en Safari, se añade a la pantalla de inicio y funciona
a pantalla completa y **sin conexión**. Todos los documentos y anotaciones se guardan en el propio iPad.

## Funciones

- **Biblioteca** de PDFs con miniaturas: importar desde Archivos / iCloud Drive, renombrar y eliminar.
- **Carpetas y subcarpetas** para clasificar los PDFs: crear, renombrar, mover (botón «Mover») y eliminar
  (al eliminar una carpeta su contenido pasa a la carpeta superior, nunca se borra). Los PDFs que importas
  dentro de una carpeta se guardan en ella.
- **Buscador** que encuentra PDFs y carpetas por nombre en toda la biblioteca, indicando en qué carpeta están.
- **Pestañas**: abre varios documentos a la vez (botón «+» o importando varios archivos) y cambia entre ellos.
  Cada pestaña recuerda su página, zoom y su historial de deshacer; se restauran al volver a abrir la app.
- **Barra lateral de miniaturas** de las páginas (con tus anotaciones), para saltar a cualquier página.
  Se muestra en documentos de varias páginas y se oculta con el botón junto a la flecha de volver.
- **Juntar PDFs** en uno nuevo, eligiendo el orden. Las anotaciones se conservan y siguen siendo editables.
- **Nueva libreta** en blanco, rayada o cuadriculada para tomar notas desde cero.
- **Bolígrafo** sensible a la presión del Apple Pencil, con colores y grosor ajustables.
- **Subrayador** translúcido que no tapa el texto.
- **Texto**: toca en cualquier sitio para escribir; toca un texto existente para editarlo. Tamaño y color ajustables.
- **Formas**: línea, flecha, rectángulo y elipse.
- **Borrador** de trazos, formas y textos.
- **Selección**: mover, duplicar, recolorear o eliminar cualquier anotación.
- **Modo «Solo lápiz»** (rechazo de la palma): el dedo desplaza la página y solo el lápiz dibuja.
  Se activa automáticamente la primera vez que se usa el Apple Pencil; se puede desactivar para dibujar con el dedo.
- **Zoom** con pellizco de dos dedos (y desplazamiento con dos dedos con cualquier herramienta), o con los botones.
- **Deshacer / rehacer** ilimitado durante la sesión (también ⌘Z / ⇧⌘Z con teclado).
- **Guardado automático** de anotaciones, página y zoom.
- **Actualización automática**: al abrir la app (o volver a ella) busca la última versión y se recarga sola.
  El número de versión aparece al pie de la biblioteca.
- **Reparación automática** de PDFs dañados o incompletos (p. ej. descargas cortadas): se recupera todo
  el contenido que haya llegado y se avisa de que puede faltar una parte.
- **Exportar** un PDF con las anotaciones incrustadas para compartirlo (Archivos, correo, AirDrop…).
- Añadir páginas en blanco al final de un documento.

## Cómo instalarla en el iPad

La app necesita publicarse en una dirección `https://`. La forma más sencilla es **GitHub Pages**:

1. En GitHub, abre el repositorio → **Settings → Pages**.
2. En *Build and deployment*, elige **Deploy from a branch**, selecciona la rama (p. ej. `main`) y la carpeta `/ (root)`, y guarda.
   (GitHub Pages gratis requiere que el repositorio sea público.)
3. Al cabo de un minuto tendrás una dirección como `https://<usuario>.github.io/1stapp/`.
4. Ábrela en **Safari** en el iPad → botón **Compartir** → **Añadir a pantalla de inicio**.
5. Abre «Anota PDF» desde el icono: funciona a pantalla completa y sin conexión.

> Importante: usa la app desde el icono de la pantalla de inicio. Safari puede borrar los datos de
> las webs que no se visitan en semanas, pero las apps añadidas a la pantalla de inicio conservan sus datos.
> Aun así, exporta los PDF importantes como copia de seguridad.

### Probarla en local

```bash
python3 -m http.server 8000
# abre http://localhost:8000 (o la IP de tu ordenador desde el iPad, en la misma red Wi-Fi)
```

## Estructura

| Archivo | Descripción |
|---|---|
| `index.html` | Interfaz (biblioteca y lector) |
| `styles.css` | Estilos (modo claro/oscuro, adaptado a iPad) |
| `app.js` | Lógica: renderizado, herramientas, gestos, guardado y exportación |
| `sw.js` | Service worker para uso sin conexión |
| `manifest.webmanifest`, `icons/` | Datos de la app instalable |
| `vendor/` | [pdf.js](https://mozilla.github.io/pdf.js/) 3.11 (Apache-2.0) y [pdf-lib](https://pdf-lib.js.org/) 1.17 (MIT) |
