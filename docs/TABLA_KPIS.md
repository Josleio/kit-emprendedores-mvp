# Tabla de KPI por rol

Generado automaticamente desde `src/etl/kpis.js` (`npm run docs`). Cada rol tiene al menos 3 KPI.

| Rol | KPI definidos |
|---|---|
| Administrador | 4 |
| Gerente | 6 |
| Cajero | 4 |

## Administrador

| Codigo | KPI | Definicion | Formula | Tablas fuente | Grafico | Operador ETL | Coleccion MongoDB |
|---|---|---|---|---|---|---|---|
| K10 | Disponibilidad saludable de inventario | Porcentaje de productos con existencias por encima del minimo (> 5 unidades). | `(productos con stock > 5 / total productos) x 100` | productos | tarjeta | Node.js (src/etl) | kpi_resultados |
| K11 | Valor del inventario a costo | Dinero invertido en la mercancia que hay hoy en bodega. | `SUM(stock x costo) de todos los productos` | productos | tarjeta | Node.js (src/etl) | kpi_resultados |
| K12 | Tasa de anulacion de ventas | Porcentaje de ventas anuladas sobre el total de ventas registradas. | `ventas anuladas / total de ventas x 100` | ventas | tarjeta | Node.js (src/etl) | kpi_resultados |
| K13 | Cobertura de identificacion de clientes | Porcentaje de ventas vigentes asociadas a un cliente registrado. | `(ventas vigentes con cliente_id / ventas vigentes) x 100` | ventas, clientes | tarjeta | Node.js (src/etl) | kpi_resultados |

## Gerente

| Codigo | KPI | Definicion | Formula | Tablas fuente | Grafico | Operador ETL | Coleccion MongoDB |
|---|---|---|---|---|---|---|---|
| K05 | Ingresos ultimos 30 dias | Ingresos del ultimo mes y crecimiento frente a los 30 dias anteriores. | `(ingresos 30d - ingresos 30d previos) / ingresos 30d previos x 100` | ventas, items_venta | tarjeta | Node.js (src/etl) | kpi_resultados |
| K06 | Margen de utilidad | Que porcentaje de lo vendido queda como ganancia. | `(ingresos - costo de lo vendido) / ingresos x 100` | ventas, items_venta | tarjeta | Node.js (src/etl) | kpi_resultados |
| K07 | Ingresos diarios (30 dias) | Ingresos de cada uno de los ultimos 30 dias (los dias sin ventas cuentan como 0). | `SUM(subtotal) de ventas no anuladas, agrupado por dia, ultimos 30 dias` | ventas, items_venta | serie | Node.js (src/etl) | kpi_resultados |
| K08 | Participacion por categoria | Porcentaje que representa cada categoria sobre el total de ingresos. | `(ingresos por categoria / ingresos totales) x 100` | ventas, items_venta, productos, categorias | barras | Node.js (src/etl) | kpi_resultados |
| K09 | ROI de ventas | Porcentaje de retorno obtenido sobre el costo de la mercancia vendida. | `(ingresos - costo vendido) / costo vendido x 100` | ventas, items_venta | tarjeta | Node.js (src/etl) | kpi_resultados |
| K14 | Productos comprados juntos | Reglas de asociacion entre productos que aparecen en la misma venta (soporte, confianza y lift). | `soporte = ventas con A y B / ventas; confianza = ventas con A y B / ventas con A; lift = confianza / soporte(B)` | ventas_resumen (MongoDB) | tabla | Python (analitica/asociacion.py) | kpi_resultados |

## Cajero

| Codigo | KPI | Definicion | Formula | Tablas fuente | Grafico | Operador ETL | Coleccion MongoDB |
|---|---|---|---|---|---|---|---|
| K01 | Ventas ultimos 7 dias | Total vendido y numero de ventas de la ultima semana. | `SUM(subtotal) de ventas no anuladas con fecha >= hoy - 7 dias` | ventas, items_venta | tarjeta | Node.js (src/etl) | kpi_resultados |
| K02 | Ticket promedio | Valor promedio de cada venta. | `SUM(subtotal) / COUNT(ventas no anuladas)` | ventas, items_venta | tarjeta | Node.js (src/etl) | kpi_resultados |
| K03 | Productos mas vendidos | Los 5 productos con mas unidades vendidas. | `SUM(cantidad) por producto, orden descendente, limite 5` | ventas, items_venta, productos | barras | Node.js (src/etl) | kpi_resultados |
| K04 | Ventas por metodo de pago | Dinero recibido segun la forma de pago. | `SUM(valor) de pagos de ventas no anuladas, agrupado por metodo` | pagos, ventas, metodos_pago | barras | Node.js (src/etl) | kpi_resultados |

## Proceso ETL

El catalogo de KPI (`src/etl/kpis.js`) solo describe cada indicador. El ETL (`src/etl/index.js`) corre tres etapas, cada una en su archivo:

1. **Extract** (`extract.js`): consulta SQL a PostgreSQL. Extrae 4 conjuntos de datos una sola vez, en una transaccion REPEATABLE READ con el contexto del negocio, por lo que RLS solo entrega datos de ese negocio.
2. **Transform** (`transform.js`): funcion pura que calcula los KPI en Node.js (sumas, promedios, porcentajes, series de 30 dias) y arma los documentos para Mongo.
3. **Load** (`load.js`): los resultados se guardan en MongoDB (`kpi_resultados`, un documento por KPI y negocio, con upsert idempotente).

Cada paso queda registrado en la coleccion `etl_log` (filas leidas, milisegundos de cada fase, estado). Ademas el ETL carga
`catalogo_productos` (catalogo documental) y `ventas_resumen` (ventas con sus items anidados), que usa Python para el KPI K14.
La documentacion de los KPI tambien queda en MongoDB (`kpi_catalogo`).

## Integracion de las tres bases de datos

| Base de datos | Funcion en la solucion |
|---|---|
| PostgreSQL | Datos transaccionales (ventas, pagos, stock), permisos por perfil y aislamiento entre negocios con RLS. |
| Redis | Sesiones efimeras: el login crea `session:{negocio}:{id}` con expiracion; cada peticion valida que siga activa. |
| MongoDB | Resultados de los KPI, bitacora del ETL y documentos analiticos. Alimenta el dashboard por rol. |

La pantalla **Analitica > Integracion** muestra el estado en vivo de las tres bases.
