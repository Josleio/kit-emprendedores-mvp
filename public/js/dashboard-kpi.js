// ============================================================================
// FRONTEND ANALITICA & BITACORA ETL (Fuente: MongoDB via /api/analitica/*)
// ----------------------------------------------------------------------------
// Consume exclusivamente los documentos calculados por el ETL en MongoDB:
//   - GET  /api/analitica/kpis      -> kpi_resultados filtrados por rol y tenant_id
//   - GET  /api/analitica/catalogo  -> metadatos y formulas de cada KPI
//   - GET  /api/analitica/etl-log   -> pasos de ejecucion (E1..E4, K01..K14, D1..D2) y JSON en Mongo
//   - POST /api/analitica/etl       -> dispara el ETL completo (PostgreSQL -> Node -> Mongo -> Python)
// ============================================================================
(function () {
    const moneyFmt = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
    let rolSeleccionado = '';
    let cacheDocumentosMongo = {};

    function formatValor(valor, unidad) {
        if (valor === null || valor === undefined) return 'Sin datos';
        if (unidad === 'money') return moneyFmt.format(valor);
        if (unidad === 'percent') return `${Number(valor).toFixed(2)}%`;
        return `${Number(valor).toLocaleString('es-CO')} ${unidad === 'unidades' ? 'und.' : ''}`.trim();
    }

    function renderSerieSvg(puntos) {
        if (!puntos || !puntos.length) return '<p class="meta">Sin puntos en la serie.</p>';
        const w = 520, h = 150, pad = 22;
        const vals = puntos.map((p) => Number(p.valor) || 0);
        const max = Math.max(...vals, 1);
        const stepX = (w - pad * 2) / Math.max(puntos.length - 1, 1);

        const coords = puntos.map((p, idx) => {
            const x = pad + idx * stepX;
            const y = h - pad - ((Number(p.valor) || 0) / max) * (h - pad * 2);
            return { x, y, fecha: p.fecha, valor: p.valor };
        });
        const poly = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
        const circles = coords.map((c) =>
            `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="3.2" fill="#0056b3"><title>${c.fecha}: ${moneyFmt.format(c.valor)}</title></circle>`
        ).join('');

        return `
            <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:165px;display:block;background:#f8fbff;border-radius:8px;border:1px solid #e3e8ee">
                <polyline fill="none" stroke="#0056b3" stroke-width="2.4" points="${poly}" />
                ${circles}
            </svg>
            <div style="display:flex;justify-content:space-between;font-size:.78rem;color:#5b6770;margin-top:.35rem">
                <span>${puntos[0].fecha}</span>
                <span>Pico: ${moneyFmt.format(max)}</span>
                <span>${puntos[puntos.length - 1].fecha}</span>
            </div>`;
    }

    function renderVisual(kpi, escapeHtml) {
        const res = kpi.resultado || {};
        if (kpi.visual === 'tarjeta') {
            const badge = res.tono === 'good'
                ? '<span class="pill ok">Saludable</span>'
                : res.tono === 'bad'
                    ? '<span class="pill" style="background:#fdecea;color:#8a1c1c">Alerta</span>'
                    : '';
            return `
                <div style="display:flex;align-items:baseline;justify-content:space-between;gap:.5rem;margin:.4rem 0">
                    <div style="font-size:1.75rem;font-weight:800;color:#0056b3">${escapeHtml(formatValor(res.valor, res.unidad))}</div>
                    ${badge}
                </div>
                <p class="meta" style="margin:0">${escapeHtml(res.nota || '')}</p>`;
        }

        if (kpi.visual === 'barras') {
            const items = res.items || [];
            if (!items.length) return '<p class="meta">Sin datos registrados.</p>';
            const max = Math.max(...items.map((i) => Number(i.valor) || 0), 1);
            return items.map((item) => {
                const pctWidth = Math.max(4, Math.round(((Number(item.valor) || 0) / max) * 100));
                return `
                    <div style="margin:.55rem 0">
                        <div style="display:flex;justify-content:space-between;font-size:.85rem;margin-bottom:.2rem">
                            <span>${escapeHtml(item.etiqueta)}</span>
                            <strong>${escapeHtml(formatValor(item.valor, res.unidad))}</strong>
                        </div>
                        <div style="background:#eef2f6;border-radius:999px;height:8px;overflow:hidden">
                            <div style="background:#0a74da;height:100%;width:${pctWidth}%"></div>
                        </div>
                    </div>`;
            }).join('');
        }

        if (kpi.visual === 'serie') {
            return renderSerieSvg(res.puntos || []);
        }

        if (kpi.visual === 'tabla') {
            const cols = res.columnas || [];
            const filas = res.filas || [];
            if (!filas.length) return '<p class="meta">Sin reglas suficientes (ejecuta ETL con Python activo).</p>';
            return `
                <div class="table-wrap" style="margin-top:.5rem">
                    <table>
                        <thead><tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
                        <tbody>${filas.map((f) => `<tr>${f.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody>
                    </table>
                </div>`;
        }
        return '';
    }

    async function loadAnalitica({ apiRequest, showMessage, escapeHtml, can }) {
        const msg = document.getElementById('analitica-message');
        const refreshBtn = document.getElementById('btn-run-etl');
        const logTabBtn = document.getElementById('tab-etl-log');
        const canRunEtl = can('/analitica', 'update');

        if (refreshBtn) refreshBtn.classList.toggle('hidden', !canRunEtl);
        if (logTabBtn) logTabBtn.classList.toggle('hidden', !canRunEtl);

        try {
            const query = rolSeleccionado ? `?rol=${encodeURIComponent(rolSeleccionado)}` : '';
            const data = await apiRequest(`/analitica/kpis${query}`);

            // Selector de rol si es Administrador
            const roleSelect = document.getElementById('kpi-role-select');
            if (data.roles_disponibles && data.roles_disponibles.length > 1) {
                roleSelect.classList.remove('hidden');
                roleSelect.innerHTML = data.roles_disponibles
                    .map((r) => `<option value="${escapeHtml(r)}" ${r === data.rol ? 'selected' : ''}>Vista Rol: ${escapeHtml(r)}</option>`)
                    .join('');
            } else {
                roleSelect.classList.add('hidden');
            }

            document.getElementById('kpi-role-subtitle').textContent =
                `Perfil: ${data.perfil || '-'} · Dashboard del rol ${data.rol} (${data.resultados.length}/${data.kpis_del_rol} KPIs cargados en MongoDB)`;

            const grid = document.getElementById('kpi-cards-grid');
            if (!data.resultados.length) {
                grid.innerHTML = `<div class="panel" style="grid-column:1/-1"><p class="meta">No hay KPIs cargados en MongoDB para este negocio. Presiona <strong>Refresh data (ETL)</strong> o ejecuta <code>npm run etl</code>.</p></div>`;
            } else {
                grid.innerHTML = data.resultados.map((kpi) => {
                    const wide = (kpi.visual === 'serie' || kpi.visual === 'tabla') ? 'grid-column: 1 / -1;' : '';
                    return `
                        <div style="background:#fff;border:1px solid #e3e8ee;border-radius:12px;padding:1.15rem;box-shadow:0 2px 8px rgba(16,42,67,.04);${wide}">
                            <div style="display:flex;justify-content:space-between;align-items:center;gap:.5rem;margin-bottom:.35rem">
                                <span style="font-size:.75rem;font-weight:700;background:#e7f0fa;color:#0056b3;padding:.15rem .55rem;border-radius:6px">${escapeHtml(kpi.codigo)}</span>
                                <span style="font-size:.75rem;color:#5b6770">MongoDB · kpi_resultados</span>
                            </div>
                            <h3 style="margin:.2rem 0 .6rem;font-size:1.05rem;color:#1f2933">${escapeHtml(kpi.nombre)}</h3>
                            ${renderVisual(kpi, escapeHtml)}
                        </div>`;
                }).join('');
            }

            // Cargar catalogo documentado
            const catalogo = await apiRequest('/analitica/catalogo');
            document.getElementById('kpi-catalogo-body').innerHTML = catalogo.map((k) => `
                <tr>
                    <td><strong>${escapeHtml(k.codigo)}</strong></td>
                    <td>${escapeHtml(k.nombre)}</td>
                    <td>${escapeHtml(k.roles.join(', '))}</td>
                    <td><code>${escapeHtml(k.formula)}</code></td>
                    <td>${escapeHtml(k.tablas.join(', '))}</td>
                    <td>${escapeHtml(k.operador)}</td>
                </tr>
            `).join('');

            // Cargar bitacora ETL si el usuario tiene permiso update
            if (canRunEtl) {
                const logData = await apiRequest('/analitica/etl-log');
                cacheDocumentosMongo = logData.documentos || {};
                document.getElementById('etl-log-body').innerHTML = (logData.pasos || []).map((p) => {
                    const tiempos = [
                        p.ms_extract !== undefined ? `E:${p.ms_extract}ms` : null,
                        p.ms_transform !== undefined ? `T:${p.ms_transform}ms` : null,
                        p.ms_load !== undefined ? `L:${p.ms_load}ms` : null,
                    ].filter(Boolean).join(' · ') || '-';
                    const pillClass = p.estado === 'OK' ? 'ok' : 'off';
                    const btnJson = cacheDocumentosMongo[p.codigo]
                        ? `<button type="button" class="secondary" data-inspect-kpi="${escapeHtml(p.codigo)}">Ver doc Mongo</button>`
                        : '';
                    return `
                        <tr>
                            <td><strong>${escapeHtml(p.codigo)}</strong></td>
                            <td>${escapeHtml(p.nombre)}<br><small style="color:#5b6770">${escapeHtml(p.operador)}</small></td>
                            <td>${escapeHtml((p.fuente || []).join(', '))}</td>
                            <td><code>${escapeHtml(p.coleccion_destino)}</code></td>
                            <td>${p.filas_extraidas ?? '-'}</td>
                            <td>${escapeHtml(p.resultado_resumen || p.error || '-')}</td>
                            <td><small>${escapeHtml(tiempos)}</small></td>
                            <td><span class="pill ${pillClass}">${escapeHtml(p.estado)}</span> ${btnJson}</td>
                        </tr>`;
                }).join('') || '<tr><td class="empty" colspan="8">Sin ejecuciones ETL registradas aun.</td></tr>';
            }
        } catch (error) {
            showMessage(msg, error.message);
        }
    }

    window.DashboardKpi = {
        init(helpers) {
            const roleSelect = document.getElementById('kpi-role-select');
            if (roleSelect) {
                roleSelect.addEventListener('change', () => {
                    rolSeleccionado = roleSelect.value;
                    loadAnalitica(helpers);
                });
            }

            const refreshBtn = document.getElementById('btn-run-etl');
            if (refreshBtn) {
                refreshBtn.addEventListener('click', async () => {
                    const msg = document.getElementById('analitica-message');
                    refreshBtn.disabled = true;
                    refreshBtn.textContent = 'Ejecutando ETL...';
                    try {
                        const res = await helpers.apiRequest('/analitica/etl', { method: 'POST' });
                        helpers.showMessage(
                            msg,
                            `ETL completado (run_id: ${res.run_id.slice(0, 8)}): ${res.kpis_ok} KPIs cargados, ${res.productos} productos, ${res.ventas} ventas (Python K14: ${res.python}).`,
                            true
                        );
                        await loadAnalitica(helpers);
                    } catch (error) {
                        helpers.showMessage(msg, error.message);
                    } finally {
                        refreshBtn.disabled = false;
                        refreshBtn.textContent = 'Refresh data (Ejecutar ETL)';
                    }
                });
            }

            document.querySelectorAll('[data-analitica-tab]').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const target = btn.dataset.analiticaTab;
                    document.querySelectorAll('[data-analitica-pane]').forEach((pane) => {
                        pane.classList.toggle('hidden', pane.dataset.analiticaPane !== target);
                    });
                });
            });

            const logBody = document.getElementById('etl-log-body');
            if (logBody) {
                logBody.addEventListener('click', (e) => {
                    const btn = e.target.closest('[data-inspect-kpi]');
                    if (!btn) return;
                    const code = btn.dataset.inspectKpi;
                    const pre = document.getElementById('mongo-doc-preview');
                    pre.classList.remove('hidden');
                    pre.textContent = JSON.stringify(cacheDocumentosMongo[code], null, 2);
                });
            }
        },
        load: loadAnalitica,
    };
})();
