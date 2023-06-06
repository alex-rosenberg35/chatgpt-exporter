import JSZip from 'jszip'
import { fetchConversation, getCurrentChatId, processConversation } from '../api'
import { KEY_TIMESTAMP_24H, KEY_TIMESTAMP_ENABLED, baseUrl } from '../constants'
import i18n from '../i18n'
import { checkIfConversationStarted, getConversationChoice, getUserAvatar } from '../page'
import templateHtml from '../template.html?raw'
import { downloadFile, getFileNameWithFormat } from '../utils/download'
import { fromMarkdown, toHtml } from '../utils/markdown'
import { ScriptStorage } from '../utils/storage'
import { standardizeLineBreaks } from '../utils/text'
import { dateStr, getColorScheme, timestamp, unixTimestampToISOString } from '../utils/utils'
import type { ApiConversationWithId, ConversationNodeMessage, ConversationResult } from '../api'
import type { ExportMeta } from '../ui/SettingContext'

export async function exportToHtml(fileNameFormat: string, metaList: ExportMeta[]) {
    if (!checkIfConversationStarted()) {
        alert(i18n.t('Please start a conversation first'))
        return false
    }

    const userAvatar = await getUserAvatar()

    const chatId = await getCurrentChatId()
    const rawConversation = await fetchConversation(chatId)
    const conversationChoices = getConversationChoice()
    const conversation = processConversation(rawConversation, conversationChoices)
    const html = conversationToHtml(conversation, userAvatar, metaList)

    const fileName = getFileNameWithFormat(fileNameFormat, 'html', { title: conversation.title, chatId, createTime: conversation.createTime, updateTime: conversation.updateTime })
    downloadFile(fileName, 'text/html', standardizeLineBreaks(html))

    return true
}

export async function exportAllToHtml(fileNameFormat: string, apiConversations: ApiConversationWithId[], metaList?: ExportMeta[]) {
    const userAvatar = await getUserAvatar()

    const zip = new JSZip()
    const filenameMap = new Map<string, number>()
    const conversations = apiConversations.map(x => processConversation(x))
    conversations.forEach((conversation) => {
        let fileName = getFileNameWithFormat(fileNameFormat, 'html', {
            title: conversation.title,
            chatId: conversation.id,
            createTime: conversation.createTime,
            updateTime: conversation.updateTime,
        })
        if (filenameMap.has(fileName)) {
            const count = filenameMap.get(fileName) ?? 1
            filenameMap.set(fileName, count + 1)
            fileName = `${fileName.slice(0, -5)} (${count}).html`
        }
        else {
            filenameMap.set(fileName, 1)
        }
        const content = conversationToHtml(conversation, userAvatar, metaList)
        zip.file(fileName, content)
    })

    const blob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: {
            level: 9,
        },
    })
    downloadFile('chatgpt-export.zip', 'application/zip', blob)

    return true
}

const transformAuthor = (author: ConversationNodeMessage['author']): string => {
    switch (author.role) {
        case 'assistant':
            return 'ChatGPT'
        case 'user':
            return 'You'
        case 'tool':
            return `Plugin${author.name ? ` (${author.name})` : ''}`
        default:
            return author.role
    }
}

/**
 * Convert the content based on the type of message
 */
const transformContent = (
    content: ConversationNodeMessage['content'],
    metadata: ConversationNodeMessage['metadata'],
) => {
    switch (content.content_type) {
        case 'text':
            return content.parts?.join('\n') || ''
        case 'code':
            return content.text || ''
        case 'tether_quote':
            return `> ${content.title || content.text || ''}`
        case 'tether_browsing_code':
            return '' // TODO: implement
        case 'tether_browsing_display': {
            const metadataList = metadata?._cite_metadata?.metadata_list
            if (Array.isArray(metadataList) && metadataList.length > 0) {
                return metadataList.map(({ title, url }) => {
                    return `> [${title}](${url})`
                }).join('\n')
            }
            return ''
        }
        default:
            return ''
    }
}

function conversationToHtml(conversation: ConversationResult, avatar: string, metaList?: ExportMeta[]) {
    const { id, title, model, modelSlug, createTime, updateTime, conversationNodes } = conversation

    const conversationHtml = conversationNodes.map(({ message }) => {
        if (!message || !message.content) return null

        const isUser = message.author.role === 'user'
        const author = transformAuthor(message.author)
        const model = message?.metadata?.model_slug === 'gpt-4' ? 'GPT-4' : 'GPT-3'
        const authorType = isUser ? 'user' : model
        const avatarEl = isUser
            ? `<img alt="${author}" />`
            : '<svg width="41" height="41"><use xlink:href="#chatgpt" /></svg>'
        const content = transformContent(message.content, message.metadata)
        let conversationContent = content

        if (isUser) {
            conversationContent = `<p>${escapeHtml(content)}</p>`
        }
        else {
            const root = fromMarkdown(content)
            conversationContent = toHtml(root)
        }

        const enableTimestamp = ScriptStorage.get<boolean>(KEY_TIMESTAMP_ENABLED) ?? false
        const timeStamp24H = ScriptStorage.get<boolean>(KEY_TIMESTAMP_24H) ?? false
        const timestamp = message?.create_time ?? ''
        const showTimestamp = enableTimestamp && timestamp
        let conversationDate = ''
        let conversationTime = ''

        if (showTimestamp) {
            const date = new Date(timestamp * 1000)
            const isoStr = date.toISOString()
            // format: 2022-01-01 10:12:00 UTC
            conversationDate = `${isoStr.split('T')[0]} ${isoStr.split('T')[1].split('.')[0]} UTC`
            // format: 20:12 / 08:12 PM
            conversationTime = timeStamp24H
                ? date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
                : date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
        }

        return `
<div class="conversation-item">
    <div class="author ${authorType}">
        ${avatarEl}
    </div>
    <div class="conversation-content-wrapper">
        <div class="conversation-content">
            ${conversationContent}
        </div>
    </div>
    ${showTimestamp ? `<div class="time" title="${conversationDate}">${conversationTime}</div>` : ''}
</div>`
    }).filter(Boolean).join('\n\n')

    const date = dateStr()
    const time = new Date().toISOString()
    const source = `${baseUrl}/c/${id}`
    const lang = document.documentElement.lang ?? 'en'
    const theme = getColorScheme()

    const _metaList = metaList
        ?.filter(x => !!x.name)
        .map(({ name, value }) => {
            const val = value
                .replace('{title}', title)
                .replace('{date}', date)
                .replace('{timestamp}', timestamp())
                .replace('{source}', source)
                .replace('{model}', model)
                .replace('{mode_name}', modelSlug)
                .replace('{create_time}', unixTimestampToISOString(createTime))
                .replace('{update_time}', unixTimestampToISOString(updateTime))

            return [name, val] as const
        })
    ?? []
    const detailsHtml = _metaList.length > 0
        ? `<details>
    <summary>Metadata</summary>
    <div class="metadata_container">
        ${_metaList.map(([key, value]) => `<div class="metadata_item"><div>${key}</div><div>${value}</div></div>`).join('\n')}
    </div>
</details>`
        : ''

    const html = templateHtml
        .replaceAll('{{title}}', title)
        .replaceAll('{{date}}', date)
        .replaceAll('{{time}}', time)
        .replaceAll('{{source}}', source)
        .replaceAll('{{lang}}', lang)
        .replaceAll('{{theme}}', theme)
        .replaceAll('{{avatar}}', avatar)
        .replaceAll('{{details}}', detailsHtml)
        .replaceAll('{{content}}', conversationHtml)
    return html
}

function escapeHtml(html: string) {
    return html
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
}
