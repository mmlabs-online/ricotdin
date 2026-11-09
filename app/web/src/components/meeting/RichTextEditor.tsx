// Rich-text editing of the summary / notes (PRO-06, part 6b). Loaded only when someone opens the
// editor (ContentEditor imports this module lazily). Tiptap / ProseMirror limited to what the
// meeting page renders (lib/editor/richDoc.ts); the text is stored as Markdown, never as HTML.
// Pasted HTML goes through the same schema: images, scripts and unknown markup are dropped, links
// keep only safe https targets. Tiptap's own <style> is not injected (CSP style-src 'self'): the
// styles live in styles/index.css.
import { useEffect, useId, useImperativeHandle, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import Heading from '@tiptap/extension-heading'
import Bold from '@tiptap/extension-bold'
import Italic from '@tiptap/extension-italic'
import Code from '@tiptap/extension-code'
import CodeBlock from '@tiptap/extension-code-block'
import { BulletList, ListItem, ListKeymap, OrderedList } from '@tiptap/extension-list'
import Link from '@tiptap/extension-link'
import { UndoRedo } from '@tiptap/extensions'
import { Bold as BoldIcon, Code as CodeIcon, Heading2, Heading3, Italic as ItalicIcon, Link as LinkIcon, List, ListOrdered, Redo2, SquareCode, Undo2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { docToMarkdown, markdownToDoc } from '../../lib/editor/richDoc'
import { safeLinkHref } from '../../lib/markdown'
import { Button } from '../ui/Button'

export interface RichTextHandle {
  focus: () => void
}

const isSafe = (url: string) => safeLinkHref(url) !== null

// One kind of formatting per piece of text, like the page renders it (`excludes: '_'`).
const EXTENSIONS = [
  Document,
  Paragraph,
  Text,
  Heading.configure({ levels: [3, 4] }),
  Bold.extend({ excludes: '_' }),
  Italic.extend({ excludes: '_' }),
  Code,
  CodeBlock,
  BulletList,
  OrderedList,
  ListItem.extend({ content: 'paragraph (bulletList | orderedList)?' }),
  ListKeymap,
  Link.extend({ excludes: '_' }).configure({
    openOnClick: false,
    autolink: true,
    linkOnPaste: true,
    defaultProtocol: 'https',
    isAllowedUri: (url) => isSafe(url),
    shouldAutoLink: (url) => isSafe(url),
    HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: null },
  }),
  UndoRedo,
]

function useToolbarState(editor: Editor) {
  return useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      code: e.isActive('code'),
      h3: e.isActive('heading', { level: 3 }),
      h4: e.isActive('heading', { level: 4 }),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      codeBlock: e.isActive('codeBlock'),
      link: e.isActive('link'),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  })
}

function Tool({ label, pressed, disabled, onClick, children }: { label: string; pressed?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Button
      variant="ghost"
      className="rich-tool"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      aria-disabled={disabled || undefined}
      tabIndex={-1}
      onMouseDown={(e) => e.preventDefault()} // keep the editor's selection
      onClick={() => {
        if (!disabled) onClick()
      }}
    >
      {children}
    </Button>
  )
}

/** WAI-ARIA toolbar: one Tab stop, arrow keys / Home / End move between the buttons. */
function onToolbarKey(e: KeyboardEvent<HTMLDivElement>) {
  const tools = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('.rich-tool'))
  const at = tools.indexOf(document.activeElement as HTMLButtonElement)
  if (at < 0) return
  const next = e.key === 'ArrowRight' ? at + 1 : e.key === 'ArrowLeft' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tools.length - 1 : null
  if (next === null) return
  e.preventDefault()
  const target = tools[(next + tools.length) % tools.length]
  for (const t of tools) t.tabIndex = t === target ? 0 : -1
  target?.focus()
}

function LinkForm({ editor, onDone }: { editor: Editor; onDone: () => void }) {
  const { t } = useTranslation()
  const current = editor.getAttributes('link').href
  const [url, setUrl] = useState(typeof current === 'string' ? current : 'https://')
  const [invalid, setInvalid] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const errId = useId()
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  function apply() {
    const href = safeLinkHref(url.trim())
    if (!href) {
      setInvalid(true)
      inputRef.current?.focus()
      return
    }
    const chain = editor.chain().focus()
    if (editor.state.selection.empty && !editor.isActive('link')) {
      chain.insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }).run()
    } else chain.extendMarkRange('link').setLink({ href }).run()
    onDone()
  }

  return (
    <div
      className="rich-link-form"
      role="group"
      aria-label={t('detail.edit.rich.linkGroup')}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation() // closes the link form, not the editor
          editor.commands.focus()
          onDone()
        } else if (e.key === 'Enter') {
          e.preventDefault()
          apply()
        }
      }}
    >
      <label>
        <span>{t('detail.edit.rich.linkUrl')}</span>
        <input
          ref={inputRef}
          type="url"
          inputMode="url"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value)
            setInvalid(false)
          }}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errId : undefined}
        />
      </label>
      <Button onClick={apply}>{t('detail.edit.rich.linkApply')}</Button>
      {editor.isActive('link') && (
        <Button
          onClick={() => {
            editor.chain().focus().extendMarkRange('link').unsetLink().run()
            onDone()
          }}
        >
          {t('detail.edit.rich.linkRemove')}
        </Button>
      )}
      <Button
        variant="ghost"
        onClick={() => {
          editor.commands.focus()
          onDone()
        }}
      >
        {t('common.cancel')}
      </Button>
      {invalid && (
        <p id={errId} className="auth-error" role="alert">
          {t('detail.edit.rich.linkInvalid')}
        </p>
      )}
    </div>
  )
}

function Toolbar({ editor, onLink }: { editor: Editor; onLink: () => void }) {
  const { t } = useTranslation()
  const s = useToolbarState(editor)
  const run = (f: (c: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) => () => void f(editor.chain().focus()).run()
  return (
    <div className="rich-toolbar" role="toolbar" aria-label={t('detail.edit.rich.toolbar')} onKeyDown={onToolbarKey}>
      <Tool label={t('detail.edit.rich.bold')} pressed={s.bold} onClick={run((c) => c.toggleBold())}>
        <BoldIcon size={16} aria-hidden="true" />
      </Tool>
      <Tool label={t('detail.edit.rich.italic')} pressed={s.italic} onClick={run((c) => c.toggleItalic())}>
        <ItalicIcon size={16} aria-hidden="true" />
      </Tool>
      <Tool label={t('detail.edit.rich.code')} pressed={s.code} onClick={run((c) => c.toggleCode())}>
        <CodeIcon size={16} aria-hidden="true" />
      </Tool>
      <Tool label={t('detail.edit.rich.link')} pressed={s.link} onClick={onLink}>
        <LinkIcon size={16} aria-hidden="true" />
      </Tool>
      <span className="rich-sep" aria-hidden="true" />
      <Tool label={t('detail.edit.rich.heading')} pressed={s.h3} onClick={run((c) => c.toggleHeading({ level: 3 }))}>
        <Heading2 size={16} aria-hidden="true" />
      </Tool>
      <Tool label={t('detail.edit.rich.subheading')} pressed={s.h4} onClick={run((c) => c.toggleHeading({ level: 4 }))}>
        <Heading3 size={16} aria-hidden="true" />
      </Tool>
      <Tool label={t('detail.edit.rich.bulletList')} pressed={s.bullet} onClick={run((c) => c.toggleBulletList())}>
        <List size={16} aria-hidden="true" />
      </Tool>
      <Tool label={t('detail.edit.rich.orderedList')} pressed={s.ordered} onClick={run((c) => c.toggleOrderedList())}>
        <ListOrdered size={16} aria-hidden="true" />
      </Tool>
      <Tool label={t('detail.edit.rich.codeBlock')} pressed={s.codeBlock} onClick={run((c) => c.toggleCodeBlock())}>
        <SquareCode size={16} aria-hidden="true" />
      </Tool>
      <span className="rich-sep" aria-hidden="true" />
      <Tool label={t('detail.edit.rich.undo')} disabled={!s.canUndo} onClick={run((c) => c.undo())}>
        <Undo2 size={16} aria-hidden="true" />
      </Tool>
      <Tool label={t('detail.edit.rich.redo')} disabled={!s.canRedo} onClick={run((c) => c.redo())}>
        <Redo2 size={16} aria-hidden="true" />
      </Tool>
    </div>
  )
}

export default function RichTextEditor({
  initial,
  onChange,
  label,
  describedBy,
  invalid,
  autoFocus = true,
  ref,
}: {
  /** Markdown the editor opens with (read once). */
  initial: string
  onChange: (markdown: string) => void
  label: string
  describedBy?: string
  invalid?: boolean
  autoFocus?: boolean
  ref?: Ref<RichTextHandle>
}) {
  const [linking, setLinking] = useState(false)
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])
  const toolbarRef = useRef<HTMLDivElement>(null)

  const editor = useEditor({
    extensions: EXTENSIONS,
    content: markdownToDoc(initial),
    injectCSS: false,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    autofocus: autoFocus ? 'start' : false,
    editorProps: { attributes: { class: 'rich-editor-content', role: 'textbox', 'aria-multiline': 'true' } },
    onUpdate: ({ editor: e }) => onChangeRef.current(docToMarkdown(e.getJSON())),
  })

  // Accessible name, description and error state follow the props.
  useEffect(() => {
    const attributes: Record<string, string> = { class: 'rich-editor-content', role: 'textbox', 'aria-multiline': 'true', 'aria-label': label }
    if (describedBy) attributes['aria-describedby'] = describedBy
    if (invalid) attributes['aria-invalid'] = 'true'
    editor.setOptions({ editorProps: { attributes } })
  }, [editor, label, describedBy, invalid])

  // The first tool is the toolbar's Tab stop.
  useEffect(() => {
    const first = toolbarRef.current?.querySelector<HTMLButtonElement>('.rich-tool')
    if (first) first.tabIndex = 0
  }, [])

  useImperativeHandle(ref, () => ({ focus: () => editor.commands.focus() }), [editor])

  return (
    <div className="rich-editor">
      <div ref={toolbarRef}>
        <Toolbar editor={editor} onLink={() => setLinking((v) => !v)} />
      </div>
      {linking && <LinkForm editor={editor} onDone={() => setLinking(false)} />}
      <EditorContent editor={editor} />
    </div>
  )
}
