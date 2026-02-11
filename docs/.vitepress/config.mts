import { defineConfig } from 'vitepress'
import fs from 'node:fs'
import path from 'node:path'

// サイドバー自動生成: docs配下のディレクトリを走査してサイドバー構成を生成
function getSidebarItems(dir: string, basePath: string = ''): any[] {
  const fullPath = path.resolve(__dirname, '..', dir)
  if (!fs.existsSync(fullPath)) return []

  const entries = fs.readdirSync(fullPath, { withFileTypes: true })
  const items: any[] = []

  // mdファイルを収集
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'index.md') {
      const name = entry.name.replace('.md', '')
      const content = fs.readFileSync(path.join(fullPath, entry.name), 'utf-8')
      const titleMatch = content.match(/^#\s+(.+)$/m)
      const title = titleMatch ? titleMatch[1] : name
      items.push({
        text: title,
        link: `${basePath}/${name}`,
      })
    }
  }

  return items
}

function getAutoSidebar(): any {
  const docsDir = path.resolve(__dirname, '..')
  const entries = fs.readdirSync(docsDir, { withFileTypes: true })
  const sidebar: Record<string, any[]> = {}

  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      const items = getSidebarItems(entry.name, `/${entry.name}`)
      if (items.length > 0) {
        // カテゴリ名: フォルダのindex.mdからタイトルを取得、なければフォルダ名
        const indexPath = path.join(docsDir, entry.name, 'index.md')
        let categoryTitle = entry.name
        if (fs.existsSync(indexPath)) {
          const content = fs.readFileSync(indexPath, 'utf-8')
          const titleMatch = content.match(/^#\s+(.+)$/m)
          if (titleMatch) categoryTitle = titleMatch[1]
        }
        sidebar[`/${entry.name}/`] = [
          {
            text: categoryTitle,
            items,
          },
        ]
      }
    }
  }

  return sidebar
}

export default defineConfig({
  title: 'CesiumJS Docs',
  description: 'CesiumJS 技術ドキュメント',
  lang: 'ja',
  base: '/mdpress/',

  themeConfig: {
    nav: [
      { text: 'Home', link: '/' },
      { text: 'CesiumJS', link: '/cesiumjs/' },
    ],

    sidebar: getAutoSidebar(),

    search: {
      provider: 'local',
    },

    outline: {
      label: '目次',
    },
  },

  markdown: {
    lineNumbers: true,
  },
})
