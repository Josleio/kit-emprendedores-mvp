"""
Analisis con Pandas y Matplotlib sobre los documentos que el ETL dejo en MongoDB (coleccion ventas_resumen).

Produce:
  1. Graficos PNG y un CSV en analitica/salida/
  2. El KPI K14 "Productos comprados juntos" (reglas de asociacion: soporte, confianza y lift).
     Se guarda en MongoDB (coleccion kpi_resultados) y aparece en el dashboard del rol Gerente.

Uso (desde la carpeta del proyecto):
    pip install -r analitica/requirements.txt
    npm run etl                      # primero el ETL de Node (PostgreSQL -> MongoDB)
    python analitica/analisis.py --tenant 1
"""
import argparse
import datetime as dt
import os
import sys
from collections import Counter
from itertools import combinations


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
    parser = argparse.ArgumentParser(description="Analisis de ventas y reglas de asociacion")
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

    ventas = list(db.ventas_resumen.find({"tenant_id": args.tenant, "estado": {"$ne": "anulada"}}, {"_id": 0}))
    if not ventas:
        sys.exit("No hay ventas en MongoDB. Ejecuta primero el ETL:  npm run etl")

    # --- Documentos -> tabla (una fila por producto vendido) ---
    df = pd.DataFrame([
        {"venta_id": v["venta_id"], "fecha": v["fecha"], "producto": i["nombre"], "categoria": i["categoria"],
         "cantidad": i["cantidad"], "subtotal": i["subtotal"], "costo": i["cantidad"] * i["costo_unitario"]}
        for v in ventas for i in v["items"]
    ])
    df["fecha"] = pd.to_datetime(df["fecha"]).dt.date

    salida = os.path.join(base, "salida")
    os.makedirs(salida, exist_ok=True)
    df.to_csv(os.path.join(salida, "ventas_detalle.csv"), index=False)

    ingresos, costo = df["subtotal"].sum(), df["costo"].sum()
    print(f"Ventas analizadas : {df['venta_id'].nunique()}")
    print(f"Ingresos          : {ingresos:,.2f}")
    print(f"Utilidad          : {ingresos - costo:,.2f}")
    print(f"ROI               : {(ingresos - costo) / costo * 100:,.1f}%" if costo else "ROI : sin costos")

    # --- Graficos ---
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

    # --- Reglas de asociacion (KPI K14) ---
    inicio = dt.datetime.now(dt.timezone.utc)
    canastas = df.groupby("venta_id")["producto"].apply(lambda s: sorted(set(s))).tolist()
    reglas = calcular_reglas(canastas, args.min_soporte, args.min_confianza)
    print(f"Reglas de asociacion encontradas: {len(reglas)}")
    for r in reglas[:5]:
        print(f"  Si compra {r['si']} -> tambien {r['entonces']}  (confianza {r['confianza']:.0%}, lift {r['lift']:.2f})")

    pd.DataFrame(reglas).to_csv(os.path.join(salida, "reglas_asociacion.csv"), index=False)
    db.kpi_resultados.replace_one(
        {"tenant_id": args.tenant, "codigo": "K14"},
        {"tenant_id": args.tenant, "codigo": "K14", "nombre": "Productos comprados juntos", "roles": ["Gerente"], "visual": "tabla",
         "resultado": {
             "columnas": ["Si compra", "Tambien compra", "Soporte", "Confianza", "Lift"],
             "filas": [[r["si"], r["entonces"], f"{r['soporte']:.1%}", f"{r['confianza']:.1%}", f"{r['lift']:.2f}"] for r in reglas[:8]],
         },
         "generado_en": inicio, "run_id": "python"},
        upsert=True,
    )
    db.etl_log.delete_many({"tenant_id": args.tenant, "codigo": "K14"})
    db.etl_log.insert_one({
        "tenant_id": args.tenant, "run_id": "python", "orden": 99, "codigo": "K14", "nombre": "Productos comprados juntos",
        "roles": ["Gerente"], "operador": "Python (analitica/analisis.py)", "fuente": ["ventas_resumen (MongoDB)"],
        "coleccion_destino": "kpi_resultados", "filas_extraidas": len(canastas), "estado": "OK",
        "resultado_resumen": f"{len(reglas)} reglas", "inicio": inicio, "fin": dt.datetime.now(dt.timezone.utc),
    })
    print(f"Listo. Archivos en {salida}. El KPI K14 ya esta en MongoDB.")


if __name__ == "__main__":
    main()
