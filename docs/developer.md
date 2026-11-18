# Arbitraje USDT · developer

## Mapa del código

```text
arbitraje/
├── server.py            # colector local y servidor HTTP
├── engine.js            # motor puro de costos y rutas
├── app.js               # interfaz, mapa de calor y simulador
├── index.html           # tablero
├── snapshot.json        # último mercado conocido
├── start.sh             # arranque del colector
├── probar.sh            # prueba del motor
└── docs/                # esta página y documentación
```

## Flujo de datos

1. `Exchanges` — APIs públicas
2. `Colector` — server.py
3. `Motor` — engine.js
4. `Tablero` — app.js

## Decisiones de diseño

- **Colector aislado** (A): Cada exchange corre en su propio hilo. Si una API falla, las otras rutas siguen calculando.
- **Snapshot de respaldo** (B): El HTML incluye el último mercado conocido. La página abre y explica aunque no haya backend.
- **Cero credenciales** (C): No hay claves, no hay firma, no hay órdenes. Solo lectura de datos públicos.

## Stack

Python 3, http.server, JavaScript ES2020, HTML/CSS, JSON.

El backend usa la biblioteca estándar de Python y un servidor HTTP simple. El frontend es JavaScript sin transpilación: engine.js no toca el DOM y app.js se encarga de la interfaz. Esa separación permite probar la fórmula con Node o desde la consola.

## Cómo extenderlo

- Separá la lógica de dominio de la interfaz: el motor debe poder probarse sin navegador.
- Mantené los datos de demo fuera de la lógica y documentá su origen.
- Si agregás una integración externa, poné las credenciales en variables de entorno y un `.env.example` con `x`.
- Agregá una prueba de humo por cada flujo crítico antes de publicar.

## Puesta en marcha

```bash
# 1. Ver el tablero con la instantánea incluida (sin red)
python3 server.py --snapshot
# Abrir http://127.0.0.1:8787

# 2. Modo colector: consulta las APIs públicas cada pocos segundos
python3 server.py

# 3. Pruebas del motor de costos
bash probar.sh
```

## Seguridad

El proyecto no usa API keys, no firma transacciones y no envía órdenes. Solo lee endpoints públicos. Aun así, revisá las condiciones de cada exchange antes de operar.

## Límites conocidos

- **No ejecuta órdenes**: Es un tablero de análisis. La ejecución y la custodia quedan fuera del proyecto.
- **Comisiones de retiro**: Bybit y OKX no siempre publican el costo de retiro; se usa una estimación declarada.
- **Datos públicos**: Los endpoints pueden cambiar o limitar tasa. El snapshot existe para eso.
- **Impuestos**: Las ganancias se declaran según la normativa chilena. El proyecto no calcula impuestos.

## Enlaces

- [README](../README.md)
- [Datasheet](datasheet.md)
- [Repositorio](https://github.com/jmadasme/arbitraje)
