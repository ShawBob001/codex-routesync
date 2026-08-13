[English](./README.md) | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Español](./README.es.md) | [Français](./README.fr.md) | [Deutsch](./README.de.md)

# Codex RouteSync

**Cambia sin fricción entre cuentas de Codex guardadas y proveedores de API compatibles con Responses, conserva el historial local de conversaciones en ambos modos y consulta el uso local de tokens por selección.**

Codex RouteSync actualiza las credenciales y el enrutamiento del proveedor en una sola operación protegida. El modo de cuenta y el modo de proveedor de API compatible utilizan el mismo almacén de historial local, por lo que cambiar la forma en que Codex se autentica no divide las conversaciones nuevas en cronologías distintas.

La extensión de VS Code abre en el área del editor un panel gráfico que muestra el modo activo, el estado del historial compartido, los tiempos de restablecimiento de la cuota de la cuenta y el uso local total de tokens. Las cuentas guardadas y los proveedores de API aparecen juntos en una sola lista plana de rutas. Los detalles de tokens incluyen un gráfico de anillo por origen, mientras que el gráfico naranja agrupa las observaciones locales por día, semana o mes. El panel puede seguir el idioma de VS Code o cambiar de inmediato entre inglés y chino simplificado.

## Vista previa de uso

Al abrir **Codex RouteSync** en la barra de actividad, las cuentas guardadas y los proveedores de API aparecen al mismo nivel en una lista plana **Accounts & API Routes**, y el panel se abre automáticamente o recupera el foco. Usa la lista para administrar cuentas y API, y el panel ancho para consultar cuotas, tiempos de restablecimiento, cambio automático e historial local de tokens.

![Panel de Codex RouteSync en inglés con tema oscuro](./assets/screenshots/dashboard-en-dark.png)

El mismo panel puede cambiar inmediatamente a chino simplificado:

![Panel de Codex RouteSync en chino simplificado con tema claro](./assets/screenshots/dashboard-zh-light.png)

Codex RouteSync funciona en Windows, macOS y Linux. Puedes usarlo desde VS Code o desde la línea de comandos.

[![Versión de GitHub](https://img.shields.io/github/v/release/ShawBob001/codex-routesync)](https://github.com/ShawBob001/codex-routesync/releases)
[![Visual Studio Marketplace](https://img.shields.io/badge/VS%20Code%20Marketplace-install-007ACC)](https://marketplace.visualstudio.com/items?itemName=ShawBob001.codex-routesync)
[![Licencia: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

## Dos modos, un solo historial local de conversaciones

```text
Modo de cuenta Codex  <->  Codex RouteSync  <->  Modo de proveedor API Responses
                               |
                    historial compartido en CODEX_HOME
```

| Función | Qué hace RouteSync |
| --- | --- |
| Cambio de cuenta y API | Aplica las credenciales de la cuenta seleccionada o el perfil del proveedor de API junto con la configuración de Codex correspondiente |
| Historial de conversaciones compartido | Mantiene los hilos locales nuevos visibles en ambos modos mediante un solo almacén de historial de Codex |
| Uso local de tokens | Indexa localmente los contadores de rollout de Codex, representa la actividad diaria, semanal o mensual y desglosa el uso registrado por cuenta guardada o proveedor de API |
| Conservación del estado | Guarda las credenciales de la cuenta o del proveedor saliente antes de aplicar el siguiente modo |
| Transiciones seguras | Procesa en serie los cambios simultáneos, escribe la autenticación de forma atómica y conserva copias de seguridad para revertir cambios |
| Gestión de la recarga | Muestra de forma predeterminada una acción de recarga no bloqueante cuando la extensión de Codex necesita leer el nuevo estado de autenticación |

> El historial compartido es local a un solo `CODEX_HOME`. No copia ni combina el historial web de ChatGPT, las tareas de Codex Cloud, los conectores, las cuotas ni el historial de conversaciones entre dispositivos.

## Inicio rápido

### Extensión de VS Code

Instala la extensión desde su [página de Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=ShawBob001.codex-routesync), o abre la vista Extensiones de VS Code y busca `Codex RouteSync`.

Para una instalación sin conexión, descarga el archivo `.vsix` más reciente desde [GitHub Releases](https://github.com/ShawBob001/codex-routesync/releases) y ejecuta **Extensions: Install from VSIX...**. También puedes usar el siguiente comando en una terminal. Sustituye VERSION por la versión incluida en el nombre del archivo descargado.

```bash
code --install-extension codex-routesync-VERSION.vsix
```

#### Migrar desde la publicación anterior de Marketplace

Si instalaste Codex SwitchBridge desde una publicación anterior de Marketplace, abre primero la instalación anterior y mueve a **Local** todas las cuentas y proveedores de API sincronizados o guardados en la nube. Después, desactiva o desinstala esa instalación, ejecuta **Developer: Reload Window**, instala Codex RouteSync desde el enlace anterior y vuelve a introducir la contraseña de almacenamiento.

Las cuentas, los proveedores de API, los archivos de configuración, las copias de seguridad y el historial compartido del `CODEX_HOME` configurado siguen disponibles. Los ajustes `codex-switchbridge.*` existentes también siguen vigentes. Las dos publicaciones usan identidades de extensión distintas, por lo que `globalState`, `SecretStorage` y la atribución por ruta guardada por la instalación anterior no se migran automáticamente.

Abre la vista **Codex RouteSync** de la barra de actividad. La lista plana **Accounts & API Routes** coloca las cuentas guardadas y los proveedores de API en el mismo directorio de la barra lateral. El panel se abrirá automáticamente o volverá al primer plano en el editor central. La acción **Open Dashboard** de la barra de título sigue disponible como alternativa.

### CLI

Instala el archivo de la CLI desde una versión de GitHub:

```bash
npm install --global ./codex-switchbridge-cli-0.3.0.tgz
codex-switchbridge --version
```

Cuando el paquete esté publicado en npm, podrás instalarlo desde el registro:

```bash
npm install --global codex-switchbridge-cli
```

## Cambiar entre cuentas y proveedores de API

En VS Code, usa **Switch Account** o **Switch API Provider**. RouteSync guarda la selección actual, actualiza `auth.json` y `config.toml` y después renueva las vistas de cuentas y proveedores.

Desde la CLI:

```bash
# Cambiar a una cuenta Codex guardada
codex-switchbridge use work

# Cambiar a un proveedor de API guardado compatible con Responses
# El historial local compartido está activado de forma predeterminada
codex-switchbridge mode team-api

# Mantener un historial específico del proveedor si la compatibilidad lo exige
codex-switchbridge mode team-api --separate-history
```

Para volver a una cuenta con nombre, usa `codex-switchbridge use <name>`. Si `mode account` identifica exactamente una cuenta guardada, restaura esa cuenta. Si hay varias, la CLI te pide que selecciones una con `use <name>` en lugar de elegir por su cuenta.

El perfil de un proveedor de API guarda la carga de autenticación para `auth.json` y la configuración del proveedor para `config.toml`. El historial compartido requiere `wire_api = "responses"` y un `base_url` válido para el proveedor.

## Panel del editor, restablecimiento de cuotas y uso local de tokens

El panel de VS Code lee los metadatos de cuota de la cuenta y los eventos acumulados `token_count` de los archivos de rollout locales de Codex en el `CODEX_HOME` actual. Muestra:

- el porcentaje restante de cada ventana de cuota devuelta por el servicio de cuentas, incluidos los límites de 5 horas, 7 días y los límites con nombre;
- cada restablecimiento de cuota disponible como una cuenta atrás en tiempo real con precisión de segundos;
- el mismo restablecimiento en hora local, con segundos y desplazamiento de zona horaria;
- la marca de tiempo UTC exacta del servicio, incluidos los milisegundos cuando existan;
- el número disponible de restablecimientos de límite obtenidos, cuando el servicio de cuentas lo proporcione;
- una acción **Use one reset** con confirmación para la cuenta actual cuando se pueda usar un restablecimiento obtenido;
- los tokens registrados totales, de entrada, de salida, de entrada en caché y de salida de razonamiento;
- los totales atribuidos y no atribuidos;
- el uso y el número de sesiones por cuenta y proveedor de API;
- un gráfico de anillo por origen que compara totales mutuamente excluyentes de cuentas, proveedores de API y uso no atribuido;
- un gráfico naranja diario, semanal o mensual con filtros de origen y fecha;
- el total, el promedio, el pico y el uso estimado del intervalo seleccionado;
- la cobertura del índice, el número de sesiones, el inicio del seguimiento y la hora de la última actualización.

Los relojes de restablecimiento prefieren la marca de tiempo absoluta que devuelve el servicio de cuotas. Si solo hay una cuenta atrás relativa, RouteSync calcula la marca de tiempo correspondiente cuando realiza la consulta. Los metadatos ausentes, no válidos o ya vencidos se muestran de forma explícita. La cuenta atrás se recalcula con el reloj del sistema y se actualiza sin renovar todo el panel. Las solicitudes de cuota y la renovación de tokens OAuth usan primero `codex-switchbridge.proxy`, después `http.proxy` de VS Code y por último las variables `HTTPS_PROXY`, `HTTP_PROXY` o `ALL_PROXY` del host de extensiones. La resolución de variables de entorno sigue respetando `NO_PROXY`. La configuración dedicada pertenece solo al equipo y se excluye de Settings Sync. VS Code guarda su valor en la configuración local. Es preferible usar un proxy local sin autenticación o proteger el archivo de configuración del equipo si la URL contiene credenciales.

El selector de idioma de la cabecera del panel permite elegir **Auto**, **English** o **简体中文**. Auto sigue el idioma de VS Code. Una selección explícita se guarda como configuración de la ventana y se aplica sin recargar VS Code.

La acción de restablecimiento usa el método oficial de Codex App Server. Comprueba que la misma cuenta guardada siga activa, solicita confirmación, consume como máximo un restablecimiento obtenido mediante una clave de idempotencia y después actualiza la cuota. Si la versión instalada de Codex no admite el consumo de restablecimientos, RouteSync abre la página oficial Usage.

La entrada y la salida componen el total registrado. La entrada en caché ya forma parte de la entrada y la salida de razonamiento ya forma parte de la salida, por lo que esos dos valores no se suman de nuevo. El gráfico de anillo usa únicamente totales atribuidos por origen que no se solapan, de modo que no cuenta dos veces la entrada en caché ni la salida de razonamiento.

La atribución por selección comienza cuando RouteSync inicia el seguimiento local. A partir de ese momento, el índice asigna cada incremento de tokens a la cuenta o al proveedor de API activo cuando Codex lo registró, incluso si una conversación continúa después de cambiar de modo. Las sesiones compartidas antiguas de `openai` no se pueden atribuir de forma segura a una entrada guardada concreta y permanecen en **Earlier or unattributed**. Las sesiones antiguas etiquetadas con un proveedor solo se atribuyen cuando su ID corresponde exactamente a un perfil guardado.

El servicio de cuentas proporciona un porcentaje restante, no una cantidad absoluta de tokens disponibles. El gráfico de historial contiene contadores de actividad locales del dispositivo, no datos de facturación, costes ni saldo remoto. La actividad indexada antigua cuya fecha no se puede precisar se marca como estimada, y la actividad sin una fecha fiable queda fuera del gráfico. Los perfiles de proveedores de API solo muestran contadores locales, salvo que el proveedor ofrezca una API de cuota compatible. RouteSync no sube el contenido de los rollouts. El índice local guarda contadores, marcas de tiempo, huellas de archivos e identificadores opacos, pero no almacena texto de conversaciones, rutas, etiquetas de cuentas, nombres de proveedores ni credenciales. Usa **Refresh Local Token Usage** para reindexar de inmediato. En caso contrario, la extensión lo hará durante el mantenimiento habitual en segundo plano.

## Cómo se mantiene disponible el historial de conversaciones

Codex suele agrupar los hilos locales por proveedor del modelo. Un ID de proveedor personalizado puede hacer que los hilos parezcan desaparecer al volver al modo de cuenta, aunque los archivos sigan existiendo.

RouteSync evita esa separación en los hilos nuevos:

1. El modo de cuenta usa el proveedor `openai` incluido en Codex.
2. Un proveedor de API compatible con Responses conserva la misma identidad de historial mientras RouteSync aplica su clave de API y su URL base.
3. Al volver, se restauran las credenciales de la cuenta y la ruta original de OpenAI.

Por tanto, ambos modos leen el mismo historial local dentro del mismo `CODEX_HOME`. RouteSync sincroniza la ruta usada para indexar el historial. No copia el texto de las conversaciones después de cada cambio.

El historial compartido está activado de forma predeterminada en la extensión de VS Code y en los cambios de proveedor compatibles de la CLI. En VS Code se controla con `codex-switchbridge.shareHistoryAcrossProviders`.

### Reparar hilos antiguos etiquetados por proveedor

Los hilos creados antes del enrutamiento compartido pueden conservar un ID específico del proveedor. Para incorporarlos al historial local compartido:

1. Detén cualquier salida activa de Codex.
2. Ejecuta **Codex RouteSync: Repair Shared Conversation History**.
3. Cuando termine la reparación, usa la acción **Reload recommended** de la barra de estado.

El comando de reparación crea copias de seguridad, cambia únicamente los campos de identidad del proveedor, valida los registros JSONL y SQLite y se detiene si un rollout cambia durante la inspección. La activación de la extensión nunca reescribe el historial. Python 3 solo es necesario para este comando de mantenimiento.

Consulta [Historial de conversaciones entre modos](./docs/shared-history.md) para conocer el alcance exacto y las comprobaciones de seguridad.

## Funciones

- Cambio con un clic entre cuentas Codex locales o sincronizadas y proveedores de API en VS Code
- Una lista plana de rutas en la barra lateral con las cuentas guardadas y los proveedores de API al mismo nivel
- Cambio de cuenta o proveedor de API con un solo comando desde la CLI
- Historial local compartido para rutas de proveedores compatibles con Responses
- Panel amplio en el editor con cuotas gráficas, relojes de restablecimiento precisos, uso de restablecimientos obtenidos, gráfico de anillo por origen e historial local de tokens filtrable por día, semana o mes
- Cambio en tiempo de ejecución entre inglés y chino simplificado, además de comandos y configuraciones de VS Code traducidos
- Visualización de cuotas de cuenta, renovación de tokens y mantenimiento rotativo en segundo plano
- Almacenamiento local o mediante VS Code Settings Sync para cuentas y proveedores guardados
- Cifrado opcional de los datos de autenticación guardados
- Importación y exportación de cuentas guardadas
- Reparación con copia de seguridad previa de hilos locales antiguos etiquetados por proveedor
- Bloqueo de cambios entre ventanas e instantáneas de reversión

## Comandos de la CLI

| Comando | Descripción |
| --- | --- |
| `codex-switchbridge add <name>` | Ejecuta `codex login` y guarda el resultado como una cuenta con nombre |
| `codex-switchbridge list` | Enumera las cuentas y los proveedores de API guardados |
| `codex-switchbridge use <name>` | Cambia a una cuenta guardada y restaura el modo de cuenta |
| `codex-switchbridge mode [name]` | Muestra el modo actual o cambia a un proveedor de API con historial compartido de forma predeterminada |
| `codex-switchbridge mode <name> --separate-history` | Cambia a un proveedor de API con historial local específico del proveedor |
| `codex-switchbridge remove <name>` | Elimina una cuenta guardada |
| `codex-switchbridge quota [name]` | Muestra el uso de cuota de una cuenta |
| `codex-switchbridge current` | Muestra la cuenta o el modo de proveedor de API actual |
| `codex-switchbridge refresh [name]` | Renueva el token de acceso de una cuenta |
| `codex-switchbridge export [file]` | Exporta las cuentas guardadas a JSON |
| `codex-switchbridge import <file>` | Importa cuentas guardadas desde un archivo JSON |

Usa `--auth-dir <path>` o `CODEX_SWITCHBRIDGE_AUTH_DIR` para guardar las entradas fuera del directorio predeterminado de Codex. Usa `--password` o `CODEX_SWITCHBRIDGE_PASSWORD` para desbloquear entradas cifradas.

## Configuración de VS Code

| Configuración | Valor predeterminado | Descripción |
| --- | --- | --- |
| `codex-switchbridge.language` | `auto` | Sigue VS Code o usa inglés o chino simplificado en el panel |
| `codex-switchbridge.proxy` | `""` | Proxy HTTP(S) exclusivo del equipo para las solicitudes de cuota y la renovación de tokens OAuth. Se excluye de Settings Sync. Si está vacío, usa la configuración de proxy de VS Code y del host de extensiones |
| `codex-switchbridge.shareHistoryAcrossProviders` | `true` | Mantiene el historial local nuevo disponible en el modo de cuenta y en los modos de proveedores de API compatibles |
| `codex-switchbridge.reloadWindowAfterSwitch` | `statusBar` | Muestra una acción de recarga, no avisa o recarga automáticamente después de un cambio |
| `codex-switchbridge.quotaRefreshInterval` | `30` | Comprueba una cuenta guardada por intervalo para mantener los tokens y actualizar la cuota |
| `codex-switchbridge.tokenAutoUpdate` | `true` | Renueva los tokens de cuentas guardadas durante el mantenimiento en segundo plano cuando han caducado o están a punto de hacerlo |
| `codex-switchbridge.showStatusBar` | `true` | Muestra la selección actual, la cuota, el uso de tokens y las recomendaciones de recarga en la barra de estado |
| `codex-switchbridge.authDirectory` | `""` | Guarda las entradas locales en este directorio. Si está vacío, usa el directorio predeterminado de Codex |

## Seguridad de los datos y los cambios

Las cuentas locales usan `auth_{name}.json`. Los proveedores de API locales usan `provider_{name}.json`. VS Code también puede guardar entradas cifradas en el almacenamiento sincronizado de la extensión.

Antes de que un cambio sobrescriba el archivo `auth.json` activo, RouteSync vuelve a guardar las credenciales más recientes de la cuenta o del proveedor saliente en la entrada correspondiente. Después actualiza la autenticación, el enrutamiento del proveedor y el estado de la ruta del historial compartido bajo un único bloqueo entre procesos. Los archivos de autenticación se sustituyen de forma atómica y, si una transición falla, se restauran sus instantáneas.

La consulta de cuotas y la indexación local de tokens son operaciones de solo lectura. No rotan tokens, no reescriben la autenticación guardada ni modifican archivos de conversaciones. El mantenimiento de tokens es una operación independiente.

Algunas herramientas de Codex almacenan en caché la autenticación al iniciarse. RouteSync no puede obligar a otro proceso de extensión a descartar esa caché, por lo que puede ser necesario recargar la ventana de VS Code después de un cambio correcto de archivos. El comportamiento predeterminado mantiene esta recomendación en la barra de estado en lugar de mostrar avisos emergentes repetidos.

No ejecutes **Codex Account Switch** y Codex RouteSync al mismo tiempo. Ambas extensiones escriben en los mismos archivos locales de Codex.

## Desarrollo

```bash
npm install
npm run build
npm run verify
```

Las pruebas visuales del panel también necesitan Playwright Chromium y sus dependencias del sistema Linux:

```bash
npx playwright install --with-deps chromium
npm run test:visual -w packages/vscode
```

Las imágenes mínimas de Linux sin `/etc/fonts/fonts.conf` deben proporcionar una configuración válida de Fontconfig mediante `FONTCONFIG_FILE` y `FONTCONFIG_PATH`. De lo contrario, Chromium no podrá medir ni renderizar texto.

Estructura del proyecto:

```text
packages/
  core/     Lógica compartida de autenticación, enrutamiento de proveedores e historial, cuotas y almacenamiento
  cli/      Interfaz de línea de comandos
  vscode/   Extensión de VS Code
scripts/    Herramientas de mantenimiento del historial y publicación
docs/       Notas sobre arquitectura, comportamiento y despliegue
```

Los procedimientos de publicación se describen en [Despliegue](./docs/deployment.md).

## Procedencia y licencia

Codex RouteSync es un proyecto independiente de código abierto derivado de [jqknono/codex-account-switch](https://github.com/jqknono/codex-account-switch), con modificaciones sustanciales realizadas por `ShawBob001`.

Se publica bajo la [Licencia MIT](./LICENSE). Se conservan el aviso de derechos de autor y el texto de la licencia del proyecto original.
