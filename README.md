# IndexLy

> Local index manager for any file. Games, books, movies, or personal lists. Load, combine, and search instantly — nothing leaves your browser.

**Web:** [indexly.daida.net](https://indexly.daida.net) · **Repository:** [github.com/daidarzzz/indexly](https://github.com/daidarzzz/indexly)

---

## 📌 What is IndexLy?

**IndexLy** allows you to import local data files and search across all of them as if they were a single database. Have two movie lists, a book collection, and a download export? Drag them in, toggle sources on or off as needed, and search in real time.

It was created to solve the need for searching across multiple unstructured files without having to set up a database or upload sensitive data to external servers. All parsing and storage happen 100% privately inside your browser.

---

## ✨ Key Features

* **Multi-format Support:** Compatible with `JSON`, `CSV`, `TSV`, `YAML`, `XML`, and `TXT` files. Import multiple files at once, use Drag & Drop, or paste content directly from your clipboard (`Ctrl+V`).
* **Automatic Field Detection:** Smart auto-mapping identifies titles, links, and metadata regardless of the original file structure.
* **Manual Mapping Control:** For complex or unique files, manually assign which field corresponds to *Title*, *Subtitle*, or *Link*.
* **Instant & Smart Search:** Real-time search across all metadata. Diacritics-insensitive (ignores accents/special characters) and features URL state syncing (`?q=`) for shareable search links.
* **Filtering & Sorting:** Quickly filter results by link availability and sort by relevance, alphabetical order, file size, or date.
* **Backup & Migration:** Export and import your saved indices to easily back up your data or transfer it between browsers.
* **100% Local & Private:** Powered by IndexedDB directly inside your browser. No registration, no backend server, and zero telemetry or external analytics.

---

## 🚀 Quick Start

1. Open [indexly.daida.net](https://indexly.daida.net).
2. Click **Add File** (or drag and drop your files directly onto the page).
3. Type in the search bar to explore your data instantly.

### Supported Data Examples

**Structured JSON Format:**

```json
{
  "name": "My Collection",
  "items": [
    { "title": "Dune", "author": "Frank Herbert", "url": "https://..." },
    { "title": "Foundation", "author": "Isaac Asimov", "year": 1951 }
  ]
}

```

**Simple Array Format:**

```json
[
  { "title": "SuperTuxKart", "fileSize": "1.2 GB", "uris": ["https://..."] }
]

```

---

## 🛠️ Local Development

To run or build the project locally, ensure you have **Node.js (>= 22.12.0)** installed:

```bash
# Clone the repository
git clone https://github.com/daidarzzz/indexly.git
cd indexly

# Install dependencies
npm ci

# Start local development server
npm run dev

# Build for production
npm run build

```

---

## ⚙️ Tech Stack

* **Framework:** [Astro 7](https://astro.build/) (Static Client-Side Rendering)
* **Styling:** Vanilla CSS with custom properties and dark mode layout.
* **Persistence:** `idb-keyval` (IndexedDB wrapper)
* **Deployment:** GitHub Pages via GitHub Actions.

---

## 📄 License

Distributed under the **MIT** License. See `LICENSE` for more information.
