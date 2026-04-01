# Canvas AI

Canvas AI is a small experiment that asks whether **large language models can draw** on a 2D raster: you describe a scene in natural language, the model streams **pixel coordinates** (and colors) as text, and a web UI paints them onto a grid.

Drawing here is a stand-in for more than prettiness. It bundles **attention to detail** with **spatial awareness** in 2D: the model must hold a layout in mind, keep coordinates inside bounds, and often emit thousands of consistent `(x, y)` pairs (and optional `#RRGGBB` colors). If the model cannot reliably place even simple figures, that is a useful datapoint about what we are actually buying when we call these systems “intelligent.”

In practice—consistent with our [demo recordings](#demo-recordings)—the project has been **more diagnostic than successful**: the pipeline works, but LLMs are poor at sustained, coherent drawing in this regime.

## What this repository does

1. **Backend** (`packages/server`): A Hono server exposes `POST /api/draw` with a user prompt and canvas size. It calls the OpenAI Chat Completions API with **streaming**, parses the assistant text incrementally, validates coordinates against the grid, and streams normalized lines to the client (one pixel per line: `x,y,#rrggbb`).
2. **Shared parser** (`packages/shared`): A streaming tokenizer turns the model’s text into `Pixel` objects `{ x, y, r, g, b }`, tolerating chunk boundaries and minor formatting noise. Unit tests live alongside the scanner.
3. **Frontend** (`packages/web`): A Vite app with a collapsible chat panel and a full-viewport canvas. It consumes the HTTP stream, runs the same scanner, and updates an `ImageData` buffer (pixelated scaling in CSS).

The API key stays on the server; see `.env.example`.

## Quick start

```bash
cp .env.example .env   # set OPENAI_API_KEY (and optionally OPENAI_MODEL)
npm install
npm run dev            # builds shared, then server (3000) + web (5173)
```

- UI: `http://localhost:5173`
- API: `http://localhost:3000/api/draw`

```bash
npm test               # scanner tests
npm run build          # production build of all packages
```

Optional server env vars for debugging coordinates in the terminal are documented in `.env.example`.

## Repository layout

| Path | Role |
|------|------|
| `packages/shared` | `XYScanner`, `Pixel` / `RGB`, `formatPixelLine`, bounds helpers |
| `packages/server` | OpenAI streaming, validation, debug logging, CORS for dev |
| `packages/web` | Chat UI, canvas, fetch + stream reader |

## Demo recordings

### Demo 1

<video src="demos/CanvasAI-1.mov" controls playsinline width="960"></video>

### Demo 2

<video src="demos/CanvasAI-2.mov" controls playsinline width="960"></video>

## Motivation and what we learned

Canvas AI was built to see whether **LLMs could draw** in a constrained, Microsoft-Paint-like setting. The answer from our runs and demos is largely **no**, at least not with the reliability and spatial coherence you would expect from a human or from a model **trained for** stroke and raster output.

That outcome supports three broader lessons:

1. **Trust and deployment** — A system that struggles to place two coherent stick figures on a grid is nonetheless deployed worldwide in customer service, project automation, content pipelines, and internal enterprise tools. That gap between **fluent language** and **reliable spatial or physical reasoning** is a reason to be **careful** when we attribute intelligence or delegate high-stakes decisions to the same family of models.

2. **What “intelligence” should mean** — These models excel at distributions they were trained on: long-form text, code-shaped artifacts, summarization, and other **text-native** tasks. They were **not** trained as general **2D raster agents** that emit stable coordinate streams under tight constraints. Strong performance on curated benchmarks does not automatically transfer to arbitrary geometric or embodied tasks. Calling that gap “general intelligence” overstates the case.

3. **The right tool for the job** — Years before the current LLM wave, [Sketch RNN](https://github.com/tensorflow/magenta/tree/main/magenta/models/sketch_rnn) (originating from Google’s Magenta project) demonstrated **sequence models trained on huge doodle datasets** to complete or generate pen strokes in a representation close to human drawing. For **structured drawing completion**, that kind of **purpose-built** model is closer to the problem than a general LLM asked to improvise coordinates. Canvas AI reinforces that **“use an LLM” is not always the right default** when the task is inherently geometric or motor.

Canvas AI remains a useful **toy benchmark**: small, inspectable, and honest about where token predictors stop being “do anything” brains—especially when the anything is **drawing in space**.

## License

This project is private / as-is unless you add an explicit license.
