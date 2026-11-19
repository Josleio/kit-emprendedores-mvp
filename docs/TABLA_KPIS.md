# Tabla de KPI por rol

Generado automaticamente desde `kpis.js` (`npm run docs`). Cada rol tiene al menos 3 KPI.

| Rol | KPI definidos |
|---|---|
| Administrador | 4 |
| Gerente | 6 |
| Cajero | 4 |

## Administrador

| Codigo | KPI | Definicion | Formula | Tablas fuente | Grafico | Operador ETL | Coleccion MongoDB |
|---|---|---|---|---|---|---|---|
| K10 | Valor del inventario | Dinero invertido en el stock actual. | `SUM(stock x costo) de todos los productos` | productos | tarjeta | Node.js (etl.js) | kpi_resultados |
| K11 | Productos con stock bajo | Productos con 5 unidades o menos, para reponer a tiempo. | `productos con stock <= 5, orden ascendente, limite 8` | productos | barras | Node.js (etl.js) | kpi_resultados |
| K12 | LTV promedio por cliente | Valor promedio que deja cada cliente a lo largo del tiempo (Customer Lifetime Value). | `SUM(total comprado por cliente) / COUNT(clientes con compras)` | clientes, ventas, items_venta | tarjeta | Node.js (etl.js) | kpi_resultados |
| K13 | Tasa de anulacion de ventas | Porcentaje de ventas que se anularon (control de calidad y fraude). | `ventas anuladas / total de ventas x 100` | ventas | tarjeta | Node.js (etl.js) | kpi_resultados |

## Gerente

| Codigo | KPI | Definicion | Formula | Tablas fuente | Grafico | Operador ETL | Coleccion MongoDB |
|---|---|---|---|---|---|---|---|
| K05 | Ingresos ultimos 30 dias | Ingresos del ultimo mes y crecimiento frente a los 30 dias anteriores. | `(ingresos 30d - ingresos 30d previos) / ingresos 30d previos x 100` | ventas, items_venta | tarjeta | Node.js (etl.js) | kpi_resultados |
| K06 | Margen de utilidad | Que porcentaje de lo vendido queda como ganancia. | `(ingresos - costo de lo vendido) / ingresos x 100` | ventas, items_venta | tarjeta | Node.js (etl.js) | kpi_resultados |
| K07 | ROI de ventas | Retorno sobre lo invertido en los productos vendidos. | `(ingresos - costo de lo vendido) / costo de lo vendido x 100` | ventas, items_venta | tarjeta | Node.js (etl.js) | kpi_resultados |
| K08 | Ingresos por categoria | Que categorias generan mas dinero. | `SUM(subtotal) agrupado por categoria del producto` | ventas, items_venta, productos, categorias | barras | Node.js (etl.js) | kpi_resultados |
| K09 | Ventas por dia (30 dias) | Evolucion diaria de los ingresos durante el ultimo mes. | `SUM(subtotal) por dia, ultimos 30 dias (dias sin ventas = 0)` | ventas, items_venta | serie | Node.js (etl.js) | kpi_resultados |
| K14 | Productos comprados juntos | Reglas de asociacion (soporte, confianza y lift) entre productos de una misma venta. | `confianza(A->B) = ventas con A y B / ventas con A;  lift = confianza / soporte(B)` | ventas_resumen (MongoDB) | tabla | Python (analitica/analisis.py) | kpi_resultados |

## Cajero

| Codigo | KPI | Definicion | Formula | Tablas fuente | Grafico | Operador ETL | Coleccion MongoDB |
|---|---|---|---|---|---|---|---|
| K01 | Ventas ultimos 7 dias | Total vendido y numero de ventas de la ultima semana. | `SUM(subtotal) de ventas no anuladas con fecha >= hoy - 7 dias` | ventas, items_venta | tarjeta | Node.js (etl.js) | kpi_resultados |
| K02 | Ticket promedio | Valor promedio de cada venta. | `SUM(subtotal) / COUNT(ventas no anuladas)` | ventas, items_venta | tarjeta | Node.js (etl.js) | kpi_resultados |
| K03 | Productos mas vendidos | Los 5 productos con mas unidades vendidas. | `SUM(cantidad) por producto, orden descendente, limite 5` | ventas, items_venta, productos | barras | Node.js (etl.js) | kpi_resultados |
| K04 | Ventas por metodo de pago | Dinero recibido segun la forma de pago. | `SUM(valor) de pagos de ventas no anuladas, agrupado por metodo` | pagos, ventas, metodos_pago | barras | Node.js (etl.js) | kpi_resultados |

## Proceso ETL de cada operador de KPI

Cada KPI es un operador independiente (archivo `kpis.js`, ejecutado por `etl.js`):

1. **Extract**: consulta SQL a PostgreSQL. Corre con el contexto del negocio, por lo que RLS solo entrega datos de ese negocio.
2. **Transform**: calculo del indicador en Node.js (sumas, promedios, porcentajes, series de 30 dias).
3. **Load**: el resultado se guarda como documento en MongoDB (`kpi_resultados`, un documento por KPI y negocio).

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
