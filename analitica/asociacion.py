"""
ETAPA 2 DEL ETL: analitica avanzada en Python (KPI K14 "Productos comprados juntos").

Es un mini ETL propio, con las mismas tres fases que el de Node:

  E  EXTRAER      lee de MongoDB los documentos ventas_resumen del negocio (sin las ventas anuladas)
  T  TRANSFORMAR  calcula reglas de asociacion A -> B con soporte, confianza y lift (Pandas)
  L  CARGAR       escribe K14 en kpi_resultados (replace + upsert) y su paso en etl_log;
                  ademas genera graficos PNG y CSV en analitica/salida/ (ignorado por git)

Contrato (el dashboard depende de esta forma, no cambiarla sin actualizar el frontend):
  kpi_resultados : { tenant_id, codigo: 'K14', nombre, roles: ['Gerente'], visual: 'tabla',
                     resultado: { columnas: [...], filas: [[...]] }, generado_en, run_id }
  ventas_resumen : { tenant_id, venta_id, fecha, estado, cliente, metodo_pago, total, costo, utilidad, items: [...] }

Uso:
    pip install -r analitica/requirements.txt
    npm run etl                                     # el orquestador de Node ejecuta esto al final
    python analitica/asociacion.py --tenant 1       # o a mano, despues de haber corrido el ETL de Node
"""
import argparse
import datetime as dt
import os
import sys
from collections import Counter
from itertools import combinations

CODIGO = "K14"
NOMBRE = "Productos comprados juntos"
OPERADOR = "Python (analitica/asociacion.py)"
COLUMNAS = ["Si compra", "Tambien compra", "Soporte", "Confianza", "Lift"]


def ahora():
    return dt.datetime.now(dt.timezone.utc)


# ---------------------------------------------------------------------------
# T. TRANSFORMAR: reglas de asociacion (funcion pura, no toca ninguna base de datos)
# ---------------------------------------------------------------------------
def calcular_reglas(canastas, min_soporte, min_confianza):
    """canastas: lista de listas de productos (una por venta). Devuelve reglas A -> B ordenadas por lift."""
    n = len(canastas)
    conteo_item, conteo_par = Counter(), Counter()
    for canasta in canastas:
        conteo_item.update(canasta)
        conteo_par.update(combinations(sorted(canasta), 2))

    reglas = []
    for (a, b), veces in conteo_par.items():
        soporte = veces / n
        if soporte < min_soporte:
            continue
        for antecedente, consecuente in ((a, b), (b, a)):
            confianza = veces / conteo_item[antecedente]
            lift = confianza / (conteo_item[consecuente] / n)
            if confianza >= min_confianza:
                reglas.append({"si": antecedente, "entonces": consecuente, "soporte": soporte, "confianza": confianza, "lift": lift})
    return sorted(reglas, key=lambda r: (r["lift"], r["confianza"]), reverse=True)


def main():
    parser = argparse.ArgumentParser(description="K14: productos comprados juntos (reglas de asociacion)")
    parser.add_argument("--tenant", type=int, default=1, help="id del negocio (tenant)")
    parser.add_argument("--min-soporte", type=float, default=0.03)
    parser.add_argument("--min-confianza", type=float, default=0.30)
    args = parser.parse_args()

    import pandas as pd
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from dotenv import load_dotenv
    from pymongo import MongoClient

    base = os.path.dirname(os.path.abspath(__file__))
    load_dotenv(os.path.join(base, "..", ".env"))
    db = MongoClient(os.getenv("MONGO_URI", "mongodb://127.0.0.1:27017"), serverSelectionTimeoutMS=3000)[os.getenv("MONGO_DB", "kit_emprendedores")]

    # ------------------------------------------------------------------ E. EXTRAER
    inicio = ahora()
    t0 = ahora()
    ventas = list(db.ventas_resumen.find({"tenant_id": args.tenant, "estado": {"$ne": "anulada"}}, {"_id": 0}))
    ms_extract = int((ahora() - t0).total_seconds() * 1000)
    if not ventas:
        sys.exit("No hay ventas en MongoDB. Ejecuta primero el ETL de Node:  npm run etl")

    # Documentos -> tabla (una fila por producto vendido)
    filas = [
        {"venta_id": v["venta_id"], "fecha": v["fecha"], "producto": i["nombre"], "categoria": i["categoria"],
         "cantidad": i["cantidad"], "subtotal": i["subtotal"], "costo": i["cantidad"] * i["costo_unitario"]}
        for v in ventas for i in v["items"]
    ]
    if not filas:
        sys.exit("Las ventas de MongoDB no tienen items. Registra ventas y vuelve a correr el ETL.")
    df = pd.DataFrame(filas)
    df["fecha"] = pd.to_datetime(df["fecha"]).dt.date

    # ------------------------------------------------------------------ T. TRANSFORMAR
    t1 = ahora()
    ingresos, costo = df["subtotal"].sum(), df["costo"].sum()
    print(f"Ventas analizadas : {df['venta_id'].nunique()}")
    print(f"Ingresos          : {ingresos:,.2f}")
    print(f"Utilidad          : {ingresos - costo:,.2f}")
    print(f"ROI               : {(ingresos - costo) / costo * 100:,.1f}%" if costo else "ROI : sin costos")

    canastas = df.groupby("venta_id")["producto"].apply(lambda s: sorted(set(s))).tolist()
    reglas = calcular_reglas(canastas, args.min_soporte, args.min_confianza)
    ms_transform = int((ahora() - t1).total_seconds() * 1000)
    print(f"Reglas de asociacion encontradas: {len(reglas)}")
    for r in reglas[:5]:
        print(f"  Si compra {r['si']} -> tambien {r['entonces']}  (confianza {r['confianza']:.0%}, lift {r['lift']:.2f})")

    # ------------------------------------------------------------------ L. CARGAR
    t2 = ahora()
    salida = os.path.join(base, "salida")
    os.makedirs(salida, exist_ok=True)
    df.to_csv(os.path.join(salida, "ventas_detalle.csv"), index=False)
    pd.DataFrame(reglas).to_csv(os.path.join(salida, "reglas_asociacion.csv"), index=False)

    diario = df.groupby("fecha")["subtotal"].sum()
    plt.figure(figsize=(9, 3.6))
    diario.plot(color="#0056b3")
    plt.title("Ingresos por dia"); plt.xlabel(""); plt.ylabel("Ingresos"); plt.tight_layout()
    plt.savefig(os.path.join(salida, "ingresos_por_dia.png"), dpi=130); plt.close()

    top = df.groupby("producto")["cantidad"].sum().sort_values().tail(8)
    plt.figure(figsize=(7, 4))
    top.plot(kind="barh", color="#0a74da")
    plt.title("Unidades vendidas por producto"); plt.xlabel("Unidades"); plt.ylabel(""); plt.tight_layout()
    plt.savefig(os.path.join(salida, "productos_mas_vendidos.png"), dpi=130); plt.close()

    # K14: idempotente (replace + upsert sobre tenant_id + codigo)
    db.kpi_resultados.replace_one(
        {"tenant_id": args.tenant, "codigo": CODIGO},
        {"tenant_id": args.tenant, "codigo": CODIGO, "nombre": NOMBRE, "roles": ["Gerente"], "visual": "tabla",
         "resultado": {
             "columnas": COLUMNAS,
             "filas": [[r["si"], r["entonces"], f"{r['soporte']:.1%}", f"{r['confianza']:.1%}", f"{r['lift']:.2f}"] for r in reglas[:8]],
         },
         "generado_en": inicio, "run_id": "python"},
        upsert=True,
    )
    ms_load = int((ahora() - t2).total_seconds() * 1000)

    # Bitacora: reemplaza solo la fila de K14 (el ETL de Node conserva esta fila al reescribir su log)
    db.etl_log.delete_many({"tenant_id": args.tenant, "codigo": CODIGO})
    db.etl_log.insert_one({
        "tenant_id": args.tenant, "run_id": "python", "orden": 99, "codigo": CODIGO, "nombre": NOMBRE,
        "fase": "analitica", "roles": ["Gerente"], "operador": OPERADOR, "fuente": ["ventas_resumen (MongoDB)"],
        "coleccion_destino": "kpi_resultados", "filas_extraidas": len(canastas),
        "ms_extract": ms_extract, "ms_transform": ms_transform, "ms_load": ms_load,
        "estado": "OK", "resultado_resumen": f"{len(reglas)} reglas", "inicio": inicio, "fin": ahora(),
    })
    print(f"Listo. Archivos en {salida}. El KPI {CODIGO} ya esta en MongoDB.")


if __name__ == "__main__":
    main()
