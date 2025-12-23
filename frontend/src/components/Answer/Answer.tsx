import { FormEvent, useContext, useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { nord } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { Checkbox, DefaultButton, Dialog, FontIcon, Stack, Text, TextField } from '@fluentui/react'
import { useBoolean } from '@fluentui/react-hooks'
import { ThumbDislike20Filled, ThumbLike20Filled } from '@fluentui/react-icons'
import DOMPurify from 'dompurify'
import remarkGfm from 'remark-gfm'
import supersub from 'remark-supersub'
import { AskResponse, Citation, Feedback, historyMessageFeedback } from '../../api'
import { XSSAllowTags, XSSAllowAttributes } from '../../constants/sanatizeAllowables'
import { AppStateContext } from '../../state/AppProvider'

import { parseAnswer } from './AnswerParser'

import styles from './Answer.module.css'

interface Props {
  answer: AskResponse
  onCitationClicked: (citedDocument: Citation) => void
  onExectResultClicked: (answerId: string) => void
}

export const Answer = ({ answer, onCitationClicked, onExectResultClicked }: Props) => {
  const initializeAnswerFeedback = (answer: AskResponse) => {
    if (answer.message_id == undefined) return undefined
    if (answer.feedback == undefined) return undefined
    if (answer.feedback.split(',').length > 1) return Feedback.Negative
    if (Object.values(Feedback).includes(answer.feedback)) return answer.feedback
    return Feedback.Neutral
  }

  const [isRefAccordionOpen, { toggle: toggleIsRefAccordionOpen }] = useBoolean(false)
  const filePathTruncationLimit = 50

  const parsedAnswer = useMemo(() => parseAnswer(answer), [answer])
  const [chevronIsExpanded, setChevronIsExpanded] = useState(isRefAccordionOpen)
  const [feedbackState, setFeedbackState] = useState(initializeAnswerFeedback(answer))
  const [isFeedbackDialogOpen, setIsFeedbackDialogOpen] = useState(false)
  const [showReportInappropriateFeedback, setShowReportInappropriateFeedback] = useState(false)
  const [negativeFeedbackList, setNegativeFeedbackList] = useState<Feedback[]>([])
  
  // NEW STATE: Add state for text input when "Others" is selected
  const [otherUnhelpfulText, setOtherUnhelpfulText] = useState('')
  const [otherHarmfulText, setOtherHarmfulText] = useState('')
  
  const appStateContext = useContext(AppStateContext)
  const FEEDBACK_ENABLED =
    appStateContext?.state.frontendSettings?.feedback_enabled && appStateContext?.state.isCosmosDBAvailable?.cosmosDB
  const SANITIZE_ANSWER = appStateContext?.state.frontendSettings?.sanitize_answer

  const handleChevronClick = () => {
    setChevronIsExpanded(!chevronIsExpanded)
    toggleIsRefAccordionOpen()
  }

  const createCitationFilepath = (citation: Citation, index: number, truncate: boolean = false) => {
    let citationFilepath = ''

    if (citation.filepath && citation.chunk_id) {
      if (truncate && citation.filepath.length > filePathTruncationLimit) {
        const citationLength = citation.filepath.length
        citationFilepath = `${citation.filepath.substring(0, 20)}...${citation.filepath.substring(citationLength - 20)} - Part ${citation.chunk_id}`
      } else {
        citationFilepath = `${citation.filepath} - Part ${citation.chunk_id}`
      }
    } else if (citation.filepath && citation.filepath.length > filePathTruncationLimit && truncate) {
      const citationLength = citation.filepath.length
      citationFilepath = `${citation.filepath.substring(0, 20)}...${citation.filepath.substring(citationLength - 20)}`
    } else {
      citationFilepath = `${citation.filepath ?? ''} `
    }
    return citationFilepath
  }

  const onLikeResponseClicked = async () => {
    if (answer.message_id == undefined) return

    let newFeedbackState = feedbackState

    if (feedbackState == Feedback.Positive) {
      newFeedbackState = Feedback.Neutral
      await historyMessageFeedback(answer.message_id, Feedback.Neutral)
    } else {
      newFeedbackState = Feedback.Positive
      await historyMessageFeedback(answer.message_id, Feedback.Positive)
    }
    setFeedbackState(newFeedbackState)

    appStateContext?.dispatch({
      type: 'SET_FEEDBACK_STATE',
      payload: { answerId: answer.message_id, feedback: newFeedbackState }
    })
  }

  const onDislikeResponseClicked = async () => {
    if (answer.message_id == undefined) return
    if (feedbackState == undefined || feedbackState == Feedback.Neutral || feedbackState == Feedback.Positive) {
      setIsFeedbackDialogOpen(true)
    } else {
      // Reset negative feedback to neutral
      setFeedbackState(Feedback.Neutral)
      await historyMessageFeedback(answer.message_id, Feedback.Neutral)
    }
    appStateContext?.dispatch({
      type: 'SET_FEEDBACK_STATE',
      payload: { answerId: answer.message_id, feedback: newFeedbackState }
    })
  }

  const updateFeedbackList = (ev?: FormEvent<HTMLElement | HTMLInputElement>, checked?: boolean) => {
    if (answer.message_id == undefined) return
    const selectedFeedback = (ev?.target as HTMLInputElement)?.id as Feedback

    let feedbackList = negativeFeedbackList.slice()
    if (checked) {
      feedbackList.push(selectedFeedback)
    } else {
      feedbackList = feedbackList.filter(f => f !== selectedFeedback)
      
      // NEW LOGIC: Clear text input when unchecking "Other" options
      if (selectedFeedback === Feedback.OtherUnhelpful) {
        setOtherUnhelpfulText('')
      } else if (selectedFeedback === Feedback.OtherHarmful) {
        setOtherHarmfulText('')
      }
    }

    setNegativeFeedbackList(feedbackList)
  }

  const onSubmitNegativeFeedback = async () => {
    if (answer.message_id == undefined) return
    
    // NEW LOGIC: Combine feedback with text input for "Others"
    let feedbackData = negativeFeedbackList.slice()
    
    // Add text input to feedback if "Others" is selected and text is provided
    if (negativeFeedbackList.includes(Feedback.OtherUnhelpful) && otherUnhelpfulText.trim()) {
      feedbackData = feedbackData.map(f => 
        f === Feedback.OtherUnhelpful ? `${f}: ${otherUnhelpfulText.trim()}` : f
      )
    }
    
    if (negativeFeedbackList.includes(Feedback.OtherHarmful) && otherHarmfulText.trim()) {
      feedbackData = feedbackData.map(f => 
        f === Feedback.OtherHarmful ? `${f}: ${otherHarmfulText.trim()}` : f
      )
    }
    
    await historyMessageFeedback(answer.message_id, feedbackData.join(','))
    resetFeedbackDialog()
  }

  const resetFeedbackDialog = () => {
    setIsFeedbackDialogOpen(false)
    setShowReportInappropriateFeedback(false)
    setNegativeFeedbackList([])
    // NEW LOGIC: Reset text inputs
    setOtherUnhelpfulText('')
    setOtherHarmfulText('')
  }

  const UnhelpfulFeedbackContent = () => {
    return (
      <>
        <div>Why wasn't this response helpful?</div>
        <Stack tokens={{ childrenGap: 4 }}>
          <Checkbox
            label="Citations are missing"
            id={Feedback.MissingCitation}
            defaultChecked={negativeFeedbackList.includes(Feedback.MissingCitation)}
            onChange={updateFeedbackList}></Checkbox>
          <Checkbox
            label="Citations are wrong"
            id={Feedback.WrongCitation}
            defaultChecked={negativeFeedbackList.includes(Feedback.WrongCitation)}
            onChange={updateFeedbackList}></Checkbox>
          <Checkbox
            label="The response is not from my data"
            id={Feedback.OutOfScope}
            defaultChecked={negativeFeedbackList.includes(Feedback.OutOfScope)}
            onChange={updateFeedbackList}></Checkbox>
          <Checkbox
            label="Inaccurate or irrelevant"
            id={Feedback.InaccurateOrIrrelevant}
            defaultChecked={negativeFeedbackList.includes(Feedback.InaccurateOrIrrelevant)}
            onChange={updateFeedbackList}></Checkbox>
          <Checkbox
            label="Other"
            id={Feedback.OtherUnhelpful}
            defaultChecked={negativeFeedbackList.includes(Feedback.OtherUnhelpful)}
            onChange={updateFeedbackList}></Checkbox>
            
          {/* NEW COMPONENT: Text input for "Other" feedback */}
          {negativeFeedbackList.includes(Feedback.OtherUnhelpful) && (
            <TextField
              placeholder="Please specify what made this response unhelpful..."
              multiline
              rows={3}
              value={otherUnhelpfulText}
              onChange={(_, newValue) => setOtherUnhelpfulText(newValue || '')}
              styles={{
                root: { marginLeft: '24px', marginTop: '8px' },
                field: { 
                  fontSize: '14px',
                  border: '1px solid #d1d1d1',
                  borderRadius: '4px'
                }
              }}
            />
          )}
        </Stack>
        <div onClick={() => setShowReportInappropriateFeedback(true)} style={{ color: '#115EA3', cursor: 'pointer' }}>
          Report inappropriate content
        </div>
      </>
    )
  }

  const ReportInappropriateFeedbackContent = () => {
    return (
      <>
        <div>
          The content is <span style={{ color: 'red' }}>*</span>
        </div>
        <Stack tokens={{ childrenGap: 4 }}>
          <Checkbox
            label="Hate speech, stereotyping, demeaning"
            id={Feedback.HateSpeech}
            defaultChecked={negativeFeedbackList.includes(Feedback.HateSpeech)}
            onChange={updateFeedbackList}></Checkbox>
          <Checkbox
            label="Violent: glorification of violence, self-harm"
            id={Feedback.Violent}
            defaultChecked={negativeFeedbackList.includes(Feedback.Violent)}
            onChange={updateFeedbackList}></Checkbox>
          <Checkbox
            label="Sexual: explicit content, grooming"
            id={Feedback.Sexual}
            defaultChecked={negativeFeedbackList.includes(Feedback.Sexual)}
            onChange={updateFeedbackList}></Checkbox>
          <Checkbox
            label="Manipulative: devious, emotional, pushy, bullying"
            defaultChecked={negativeFeedbackList.includes(Feedback.Manipulative)}
            id={Feedback.Manipulative}
            onChange={updateFeedbackList}></Checkbox>
          <Checkbox
            label="Other"
            id={Feedback.OtherHarmful}
            defaultChecked={negativeFeedbackList.includes(Feedback.OtherHarmful)}
            onChange={updateFeedbackList}></Checkbox>
            
          {/* NEW COMPONENT: Text input for "Other" harmful content */}
          {negativeFeedbackList.includes(Feedback.OtherHarmful) && (
            <TextField
              placeholder="Please specify the inappropriate content..."
              multiline
              rows={3}
              value={otherHarmfulText}
              onChange={(_, newValue) => setOtherHarmfulText(newValue || '')}
              styles={{
                root: { marginLeft: '24px', marginTop: '8px' },
                field: { 
                  fontSize: '14px',
                  border: '1px solid #d1d1d1',
                  borderRadius: '4px'
                }
              }}
            />
          )}
        </Stack>
      </>
    )
  }

  const components = {
    code({ node, ...props }: { node: any;[key: string]: any }) {
      let language
      if (props.className) {
        const match = props.className.match(/language-(\w+)/)
        language = match ? match[1] : undefined
      }
      const codeString = node.children[0].value ?? ''
      return (
        <SyntaxHighlighter style={nord} language={language} PreTag="div" {...props}>
          {codeString}
        </SyntaxHighlighter>
      )
    }
  }
  return (
    <>
      <Stack className={styles.answerContainer} tabIndex={0}>
        <Stack.Item>
          <Stack horizontal grow>
            <Stack.Item grow>
              {parsedAnswer && <ReactMarkdown
                linkTarget="_blank"
                remarkPlugins={[remarkGfm, supersub]}
                children={
                  SANITIZE_ANSWER
                    ? DOMPurify.sanitize(parsedAnswer?.markdownFormatText, { ALLOWED_TAGS: XSSAllowTags, ALLOWED_ATTR: XSSAllowAttributes })
                    : parsedAnswer?.markdownFormatText
                }
                className={styles.answerText}
                components={components}
              />}
            </Stack.Item>
            <Stack.Item className={styles.answerHeader}>
              {FEEDBACK_ENABLED && answer.message_id !== undefined && (
                <Stack horizontal horizontalAlign="space-between">
                  <ThumbLike20Filled
                    aria-hidden="false"
                    aria-label="Like this response"
                    onClick={() => onLikeResponseClicked()}
                    style={
                      feedbackState === Feedback.Positive ||
                        appStateContext?.state.feedbackState[answer.message_id] === Feedback.Positive
                        ? { color: 'darkgreen', cursor: 'pointer' }
                        : { color: 'slategray', cursor: 'pointer' }
                    }
                  />
                  <ThumbDislike20Filled
                    aria-hidden="false"
                    aria-label="Dislike this response"
                    onClick={() => onDislikeResponseClicked()}
                    style={
                      feedbackState !== Feedback.Positive &&
                        feedbackState !== Feedback.Neutral &&
                        feedbackState !== undefined
                        ? { color: 'darkred', cursor: 'pointer' }
                        : { color: 'slategray', cursor: 'pointer' }
                    }
                  />
                </Stack>
              )}
            </Stack.Item>
          </Stack>
        </Stack.Item>
        {parsedAnswer?.generated_chart !== null && (
          <Stack className={styles.answerContainer}>
            <Stack.Item grow>
              <img src={`data:image/png;base64, ${parsedAnswer?.generated_chart}`} />
            </Stack.Item>
          </Stack>
        )}
        <Stack horizontal className={styles.answerFooter}>
          {!!parsedAnswer?.citations.length && (
            <Stack.Item onKeyDown={e => (e.key === 'Enter' || e.key === ' ' ? toggleIsRefAccordionOpen() : null)}>
              <Stack style={{ width: '100%' }}>
                <Stack horizontal horizontalAlign="start" verticalAlign="center">
                  <Text
                    className={styles.accordionTitle}
                    onClick={toggleIsRefAccordionOpen}
                    aria-label="Open references"
                    tabIndex={0}
                    role="button">
                    <span>
                      {parsedAnswer.citations.length > 1
                        ? parsedAnswer.citations.length + ' references'
                        : '1 reference'}
                    </span>
                  </Text>
                  <FontIcon
                    className={styles.accordionIcon}
                    onClick={handleChevronClick}
                    iconName={chevronIsExpanded ? 'ChevronDown' : 'ChevronRight'}
                  />
                </Stack>
              </Stack>
            </Stack.Item>
          )}
          <Stack.Item className={styles.answerDisclaimerContainer}>
            <span className={styles.answerDisclaimer}>AI-generated content may be incorrect</span>
          </Stack.Item>
          {!!answer.exec_results?.length && (
            <Stack.Item onKeyDown={e => (e.key === 'Enter' || e.key === ' ' ? toggleIsRefAccordionOpen() : null)}>
              <Stack style={{ width: '100%' }}>
                <Stack horizontal horizontalAlign="start" verticalAlign="center">
                  <Text
                    className={styles.accordionTitle}
                    onClick={() => onExectResultClicked(answer.message_id ?? '')}
                    aria-label="Open Intents"
                    tabIndex={0}
                    role="button">
                    <span>
                      Show Intents
                    </span>
                  </Text>
                  <FontIcon
                    className={styles.accordionIcon}
                    onClick={handleChevronClick}
                    iconName={'ChevronRight'}
                  />
                </Stack>
              </Stack>
            </Stack.Item>
          )}
        </Stack>
        {chevronIsExpanded && (
          <div className={styles.citationWrapper}>
            {parsedAnswer?.citations.map((citation, idx) => {
              return (
                <span
                  title={createCitationFilepath(citation, ++idx)}
                  tabIndex={0}
                  role="link"
                  key={idx}
                  onClick={() => onCitationClicked(citation)}
                  onKeyDown={e => (e.key === 'Enter' || e.key === ' ' ? onCitationClicked(citation) : null)}
                  className={styles.citationContainer}
                  aria-label={createCitationFilepath(citation, idx)}>
                  <div className={styles.citation}>{idx}</div>
                  {createCitationFilepath(citation, idx, true)}
                </span>
              )
            })}
          </div>
        )}
      </Stack>
      <Dialog
        onDismiss={() => {
          resetFeedbackDialog()
          setFeedbackState(Feedback.Neutral)
        }}
        hidden={!isFeedbackDialogOpen}
        styles={{
          main: [
            {
              selectors: {
                ['@media (min-width: 480px)']: {
                  maxWidth: '600px',
                  background: '#FFFFFF',
                  boxShadow: '0px 14px 28.8px rgba(0, 0, 0, 0.24), 0px 0px 8px rgba(0, 0, 0, 0.2)',
                  borderRadius: '8px',
                  maxHeight: '700px', // Increased to accommodate text input
                  minHeight: '100px'
                }
              }
            }
          ]
        }}
        dialogContentProps={{
          title: 'Submit Feedback',
          showCloseButton: true
        }}>
        <Stack tokens={{ childrenGap: 4 }}>
          <div>Your feedback will improve this experience.</div>

          {!showReportInappropriateFeedback ? <UnhelpfulFeedbackContent /> : <ReportInappropriateFeedbackContent />}

          <div>By pressing submit, your feedback will be visible to the application owner.</div>

          {/* NEW LOGIC: Enhanced submit validation to require text when "Others" is selected */}
          <DefaultButton 
            disabled={
              negativeFeedbackList.length < 1 ||
              (negativeFeedbackList.includes(Feedback.OtherUnhelpful) && !otherUnhelpfulText.trim()) ||
              (negativeFeedbackList.includes(Feedback.OtherHarmful) && !otherHarmfulText.trim())
            } 
            onClick={onSubmitNegativeFeedback}>
            Submit
          </DefaultButton>
        </Stack>
      </Dialog>
    </>
  )
}