// Rich-text editing of the summary / notes (PRO-06, part 6b). Loaded only when someone opens the
// editor (ContentEditor imports this module lazily). Tiptap / ProseMirror limited to what the
// meeting page renders (lib/editor/richDoc.ts); the text is stored as Markdown, never as HTML.
// Pasted HTML goes through the same schema: images, scripts and unknown markup are dropped, links
// keep only safe https targets. Tiptap's own <style> is not injected (CSP style-src 'self'): the
// styles live in styles/index.css.
import { useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { EditorContent, Extension, useEditor, useEditorState, type Editor } from '@tiptap/react'
import { Plugin } from '@tiptap/pm/state'
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
import { Bold as BoldIcon, Code as CodeIcon, Heading3, Heading4, Italic as ItalicIcon, Link as LinkIcon, List, ListOrdered, Redo2, SquareCode, Undo2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { docToMarkdown, markdownToDoc } from '../../lib/editor/richDoc'
import { safeLinkHref, type MarkdownOptions } from '../../lib/markdown'
import { Button } from '../ui/Button'

export interface RichTextHandle {
  focus: () => void
}

const isSafe = (url: string) => safeLinkHref(url) !== null

const isList = (name: string | undefined) => name === 'bulletList' || name === 'orderedList'

/** A list inside a list item takes the type of the list around it: the page nests one type per
 *  list (lib/markdown.ts), so a numbered list inside bullets would fall apart there. */
const SameListType = Extension.create({
  name: 'sameListType',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction(trs, _old, state) {
          if (!trs.some((t) => t.docChanged)) return null
          const tr = state.tr
          state.doc.descendants((node, pos, parent, index) => {
            void index
            if (!isList(node.type.name) || parent?.type.name !== 'listItem') return
            const outer = state.doc.resolve(pos).node(-1)
            if (isList(outer.type.name) && outer.type !== node.type) tr.setNodeMarkup(pos, outer.type)
          })
          return tr.docChanged ? tr : null
        },
      }),
    ]
  },
})

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
    autolink: false, // typing after an AI's bare domain must not make it a link (security review L1)
    linkOnPaste: true,
    defaultProtocol: 'https',
    isAllowedUri: (url) => isSafe(url),
    shouldAutoLink: (url) => isSafe(url),
    HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: null },
  }),
  UndoRedo,
  SameListType,
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

function Tool({
  label,
  pressed,
  expanded,
  controls,
  disabled,
  onClick,
  children,
}: {
  label: string
  pressed?: boolean
  expanded?: boolean
  controls?: string
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Button
      variant="ghost"
      className="rich-tool"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      aria-expanded={expanded}
      aria-controls={controls}
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

function LinkForm({ id, editor, onDone }: { id: string; editor: Editor; onDone: () => void }) {
  const { t } = useTranslation()
  const current = editor.getAttributes('link').href
  const [url, setUrl] = useState(typeof current === 'string' ? current : 'https://')
  const [invalidN, setInvalidN] = useState(0) // a fresh alert node each time, so a repeat is announced
  const invalid = invalidN > 0
  const inputRef = useRef<HTMLInputElement>(null)
  const errId = useId()
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  function apply() {
    const href = safeLinkHref(url.trim())
    if (!href) {
      setInvalidN((n) => n + 1)
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
      id={id}
      className="rich-link-form"
      role="group"
      aria-label={t('detail.edit.rich.linkGroup')}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation() // closes the link form, not the editor
          editor.commands.focus()
          onDone()
        } else if (e.key === 'Enter' && e.target === inputRef.current) {
          // Enter on Remove / Cancel does what that button says
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
            setInvalidN(0)
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
        <p id={errId} key={invalidN} className="auth-error" role="alert">
          {t('detail.edit.rich.linkInvalid')}
        </p>
      )}
    </div>
  )
}

function Toolbar({ editor, linking, linkFormId, onLink }: { editor: Editor; linking: boolean; linkFormId: string; onLink: () => void }) {
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
      <Tool label={t(s.link ? 'detail.edit.rich.linkEdit' : 'detail.edit.rich.link')} expanded={linking} controls={linking ? linkFormId : undefined} onClick={onLink}>
        <LinkIcon size={16} aria-hidden="true" />
      </Tool>
      <span className="rich-sep" aria-hidden="true" />
      <Tool label={t('detail.edit.rich.heading')} pressed={s.h3} onClick={run((c) => c.toggleHeading({ level: 3 }))}>
        <Heading3 size={16} aria-hidden="true" />
      </Tool>
      <Tool label={t('detail.edit.rich.subheading')} pressed={s.h4} onClick={run((c) => c.toggleHeading({ level: 4 }))}>
        <Heading4 size={16} aria-hidden="true" />
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
  options,
  onChange,
  label,
  describedBy,
  invalid,
  autoFocus = true,
  ref,
}: {
  /** Markdown the editor opens with (read once). */
  initial: string
  /** how the page renders this text (AI text / blocked targets open as plain text) */
  options: MarkdownOptions
  onChange: (markdown: string) => void
  label: string
  describedBy?: string
  invalid?: boolean
  autoFocus?: boolean
  ref?: Ref<RichTextHandle>
}) {
  const [linking, setLinking] = useState(false)
  const linkFormId = useId()
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])
  const toolbarRef = useRef<HTMLDivElement>(null)

  // Tiptap compares options by reference on every render and re-applies them when one differs:
  // the document is built once, and the accessibility attributes change only with their props.
  const [content] = useState(() => markdownToDoc(initial, options))
  const editorProps = useMemo(() => {
    const attributes: Record<string, string> = { class: 'rich-editor-content markdown', role: 'textbox', 'aria-multiline': 'true', 'aria-label': label }
    if (describedBy) attributes['aria-describedby'] = describedBy
    if (invalid) attributes['aria-invalid'] = 'true'
    return { attributes }
  }, [label, describedBy, invalid])
  const editor = useEditor({
    extensions: EXTENSIONS,
    content,
    injectCSS: false,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    autofocus: autoFocus ? 'start' : false,
    editorProps,
    onUpdate: ({ editor: e }) => onChangeRef.current(docToMarkdown(e.getJSON())),
  })

  // The first tool is the toolbar's Tab stop.
  useEffect(() => {
    const first = toolbarRef.current?.querySelector<HTMLButtonElement>('.rich-tool')
    if (first) first.tabIndex = 0
  }, [])

  useImperativeHandle(ref, () => ({ focus: () => editor.commands.focus() }), [editor])

  return (
    <div className="rich-editor">
      <div ref={toolbarRef}>
        <Toolbar editor={editor} linking={linking} linkFormId={linkFormId} onLink={() => setLinking((v) => !v)} />
      </div>
      {linking && <LinkForm id={linkFormId} editor={editor} onDone={() => setLinking(false)} />}
      <EditorContent editor={editor} />
    </div>
  )
}
