# Graph Report - kivo  (2026-06-11)

## Corpus Check
- 779 files · ~565,516 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 7286 nodes · 15784 edges · 78 communities detected
- Extraction: 94% EXTRACTED · 6% INFERRED · 0% AMBIGUOUS · INFERRED: 870 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 38|Community 38]]
- [[_COMMUNITY_Community 39|Community 39]]
- [[_COMMUNITY_Community 40|Community 40]]
- [[_COMMUNITY_Community 41|Community 41]]
- [[_COMMUNITY_Community 42|Community 42]]
- [[_COMMUNITY_Community 43|Community 43]]
- [[_COMMUNITY_Community 44|Community 44]]
- [[_COMMUNITY_Community 45|Community 45]]
- [[_COMMUNITY_Community 46|Community 46]]
- [[_COMMUNITY_Community 47|Community 47]]
- [[_COMMUNITY_Community 48|Community 48]]
- [[_COMMUNITY_Community 49|Community 49]]
- [[_COMMUNITY_Community 50|Community 50]]
- [[_COMMUNITY_Community 51|Community 51]]
- [[_COMMUNITY_Community 52|Community 52]]
- [[_COMMUNITY_Community 53|Community 53]]
- [[_COMMUNITY_Community 54|Community 54]]
- [[_COMMUNITY_Community 55|Community 55]]
- [[_COMMUNITY_Community 56|Community 56]]
- [[_COMMUNITY_Community 57|Community 57]]
- [[_COMMUNITY_Community 58|Community 58]]
- [[_COMMUNITY_Community 59|Community 59]]
- [[_COMMUNITY_Community 60|Community 60]]
- [[_COMMUNITY_Community 61|Community 61]]
- [[_COMMUNITY_Community 62|Community 62]]
- [[_COMMUNITY_Community 63|Community 63]]
- [[_COMMUNITY_Community 64|Community 64]]
- [[_COMMUNITY_Community 65|Community 65]]
- [[_COMMUNITY_Community 66|Community 66]]
- [[_COMMUNITY_Community 67|Community 67]]
- [[_COMMUNITY_Community 68|Community 68]]
- [[_COMMUNITY_Community 71|Community 71]]
- [[_COMMUNITY_Community 75|Community 75]]
- [[_COMMUNITY_Community 77|Community 77]]
- [[_COMMUNITY_Community 81|Community 81]]
- [[_COMMUNITY_Community 82|Community 82]]
- [[_COMMUNITY_Community 83|Community 83]]
- [[_COMMUNITY_Community 84|Community 84]]
- [[_COMMUNITY_Community 88|Community 88]]
- [[_COMMUNITY_Community 93|Community 93]]

## God Nodes (most connected - your core abstractions)
1. `serverError()` - 209 edges
2. `warn()` - 149 edges
3. `ConfigNamespace` - 141 edges
4. `badRequest()` - 131 edges
5. `TemplateNamespace` - 115 edges
6. `notFound()` - 110 edges
7. `shadow()` - 93 edges
8. `main()` - 90 edges
9. `getStringOption()` - 85 edges
10. `Kivo` - 53 edges

## Surprising Connections (you probably didn't know these)
- `writeStagingMaterials()` --calls--> `writeStagingMaterialsToDb()`  [INFERRED]
  web/lib/wiki-materials.ts → src/wiki/collection/staging-materials.ts
- `synthesizeWithLlm()` --calls--> `shouldBypassExternalModelsInTests()`  [INFERRED]
  web/lib/research-db.ts → src/utils/test-runtime.ts
- `findSemanticResearchTopic()` --calls--> `shouldBypassExternalModelsInTests()`  [INFERRED]
  web/lib/research-db.ts → src/utils/test-runtime.ts
- `GET()` --calls--> `createEmbeddingProvider()`  [INFERRED]
  web/app/api/entries/route.ts → src/embedding/create-provider.ts
- `GET()` --calls--> `createEmbeddingProvider()`  [INFERRED]
  web/app/api/v1/search/route.ts → src/embedding/create-provider.ts

## Communities

### Community 0 - "Community 0"
Cohesion: 0.0
Nodes (509): A, AbortException, Acrobat, Acrobat7, ADBE_JSConsole, ADBE_JSDebugger, addHTML(), AddSilentPrint (+501 more)

### Community 1 - "Community 1"
Cohesion: 0.01
Nodes (140): addChildren(), addLocallyCachedImageOps(), adjustMapping(), AESBaseCipher, Annotation, AnnotationBorderStyle, AnnotationFactory, AppearanceStreamEvaluator (+132 more)

### Community 2 - "Community 2"
Cohesion: 0.01
Nodes (131): OpenClawAdapter, StandaloneAdapter, AssociationDiscovery, cosineSimilarity(), AssociationEnhancedRetrieval, percentile(), AssociationStore, annotateWeights() (+123 more)

### Community 3 - "Community 3"
Cohesion: 0.01
Nodes (353): mapRepoError(), normalizeStr(), POST(), POST(), POST(), GET(), DELETE(), GET() (+345 more)

### Community 4 - "Community 4"
Cohesion: 0.01
Nodes (294): computeNodeWeight(), ensureGraphSchema(), formatGraphAlignmentReport(), GraphAlignmentChecker, parseTags(), resolveDbPath(), runGraphAlignment(), BootstrapRunner (+286 more)

### Community 5 - "Community 5"
Cohesion: 0.01
Nodes (112): startSSE(), CognitiveModeSwitcher(), CognitivePanel(), cn(), KeyboardShortcutsProvider(), useKeyboardShortcuts(), entryToMarkdown(), fetchAllEntries() (+104 more)

### Community 6 - "Community 6"
Cohesion: 0.01
Nodes (98): createInMemoryStore(), formatConfig(), formatReport(), runGovernanceConfig(), runGovernanceReport(), runGovernanceRun(), initGraphSchema(), resolveDbPath() (+90 more)

### Community 7 - "Community 7"
Cohesion: 0.01
Nodes (97): GraphAlignmentChecker, runUpdate(), createAnalysisArtifact(), ChunkStrategy, estimateTokens(), ConversationExtractor, normalizeSimilarSentences(), normalizeWhy() (+89 more)

### Community 8 - "Community 8"
Cohesion: 0.01
Nodes (76): addHex(), Ascii85Stream, AsciiHexStream, AstNode, BaseLocalCache, BasePdfManager, BaseShading, BaseStream (+68 more)

### Community 9 - "Community 9"
Cohesion: 0.01
Nodes (90): detectMimeType(), DocCollector, extractMarkdownTitle(), normalizeDocument(), parsePdf(), applyDraftEdits(), summarizeContentDiff(), WikiCollectionPipeline (+82 more)

### Community 10 - "Community 10"
Cohesion: 0.03
Nodes (148): GET(), GET(), cleanupGarbageTerms(), createDictionaryEntry(), deleteDictionaryEntry(), ensureDictionaryTable(), formatRelative(), getDictionaryData() (+140 more)

### Community 11 - "Community 11"
Cohesion: 0.02
Nodes (21): bgeLocalEmbed(), buildCandidates(), cacheKey(), describeEmbeddingConfig(), embed(), embedBatch(), EmbeddingUnavailableError, getCached() (+13 more)

### Community 12 - "Community 12"
Cohesion: 0.01
Nodes (3): Commands, ConfigNamespace, StateManager

### Community 13 - "Community 13"
Cohesion: 0.03
Nodes (60): AudioTranscriptionError, formatBytes(), isCommandNotFound(), normalizeLanguage(), normalizeModel(), normalizeSegments(), parseWhisperOutput(), WhisperTranscriber (+52 more)

### Community 14 - "Community 14"
Cohesion: 0.03
Nodes (33): rowToPartialEntry(), runDomainGoalCheck(), boostByDomainGoal(), checkExtractionBoundary(), detectGaps(), enforceConstraints(), getEmbedder(), rowToGoal() (+25 more)

### Community 15 - "Community 15"
Cohesion: 0.04
Nodes (28): assert(), ContextCache, convertBlackAndWhiteToRGBA(), convertToRGBA(), decodeAndClamp(), decodeBitmap(), decodeIAID(), decodeInteger() (+20 more)

### Community 16 - "Community 16"
Cohesion: 0.05
Nodes (75): batchEmbedTexts(), buildUserPrompt(), classify(), cosineSimilarity(), embedText(), loadAllSubjectNodes(), makeFailedResult(), renderSubjectTreeText() (+67 more)

### Community 17 - "Community 17"
Cohesion: 0.05
Nodes (53): CleanupManager, summarize(), toCleanupEntries(), ExpiryDetector, appendVersionHistory(), buildKnowledgeFilter(), buildRuleTags(), cloneSource() (+45 more)

### Community 18 - "Community 18"
Cohesion: 0.04
Nodes (9): AlternateCS, ARCFourCipher, CalGrayCS, CalRGBCS, DeviceCmykCS, DeviceRgbaCS, IndexedCS, LabCS (+1 more)

### Community 19 - "Community 19"
Cohesion: 0.06
Nodes (7): CFFCompiler, CFFDict, CFFOffsetTracker, CFFParser, CFFPrivateDict, CFFStrings, CFFTopDict

### Community 20 - "Community 20"
Cohesion: 0.04
Nodes (4): MetadataParser, SimpleDOMNode, XFAObject, XFAObjectArray

### Community 21 - "Community 21"
Cohesion: 0.08
Nodes (37): bufferToVector(), buildPrompt(), clamp01(), completeSubjectRelations(), cosineSimilarity(), ensureEntryEmbedding(), ensureGraphNode(), ensureGraphSchema() (+29 more)

### Community 22 - "Community 22"
Cohesion: 0.09
Nodes (28): clamp(), ContextInjector, fitWithinBudget(), formatSourceLabel(), normalizePositiveInteger(), normalizeThreshold(), normalizeTokenBudget(), pickSummary() (+20 more)

### Community 23 - "Community 23"
Cohesion: 0.12
Nodes (37): addSessionMessage(), applyGovernanceFilter(), captureRealtimeKnowledge(), cosineSimilarity(), createRealtimeLlmProvider(), decodeEmbedding(), embedIntentQuery(), enrichEntriesWithGovernanceFields() (+29 more)

### Community 24 - "Community 24"
Cohesion: 0.09
Nodes (14): ensureSubjectMutationSchema(), hasColumn(), collectMaterialIds(), domainFallbackId(), extractMaterialIdsFromEntry(), extractMaterialIdsFromString(), isMaterialIdKey(), mapSqliteError() (+6 more)

### Community 25 - "Community 25"
Cohesion: 0.11
Nodes (18): checkEnvironment(), formatEnvCheckReport(), checkCodeBlockSyntax(), collectExports(), collectSourceSymbols(), findInSource(), verifyDocCodeConsistency(), run() (+10 more)

### Community 26 - "Community 26"
Cohesion: 0.09
Nodes (13): compareVersions(), MigrationRunner, encode_texts(), load_model(), main(), HTTP serve mode: proxy embedding requests to configured provider., Load the BGE model once and return it., Encode a list of texts and return list of embedding vectors. (+5 more)

### Community 27 - "Community 27"
Cohesion: 0.09
Nodes (5): CapabilityRegistry, cloneCapability(), cloneProvider(), LLMProviderManager, ProviderUnavailableError

### Community 28 - "Community 28"
Cohesion: 0.14
Nodes (22): POST(), safeCompare(), createUser(), ensureUsersTable(), findUserByUsername(), getDb(), getDbPath(), hashPassword() (+14 more)

### Community 29 - "Community 29"
Cohesion: 0.1
Nodes (3): DatasetXMLParser, XFAParser, XMLParserBase

### Community 30 - "Community 30"
Cohesion: 0.11
Nodes (7): ensureIntentTables(), openWebDb(), reviveGovernanceReport(), reviveIntent(), reviveMergeOperation(), WebGovernanceStore, PendingClassificationsRepository

### Community 31 - "Community 31"
Cohesion: 0.1
Nodes (5): KnowledgeRouter, keywordOverlap(), MergeDetector, makeEntry(), makeSource()

### Community 32 - "Community 32"
Cohesion: 0.08
Nodes (1): LocaleSetNamespace

### Community 33 - "Community 33"
Cohesion: 0.11
Nodes (5): MessageHandler, PDFWorkerStreamRangeReader, PDFWorkerStreamReader, WorkerMessageHandler, wrapReason()

### Community 34 - "Community 34"
Cohesion: 0.16
Nodes (4): normalizeRawItem(), parseDelimitedValue(), TermImporter, toStringArray()

### Community 35 - "Community 35"
Cohesion: 0.19
Nodes (19): pdfTextToMarkdown(), resolveDbPath(), runIngestPdf(), parsePdf(), buildPageMetadata(), callVisionApi(), chatCompletionUrl(), clampConfidence() (+11 more)

### Community 36 - "Community 36"
Cohesion: 0.23
Nodes (20): addSessionMessage(), estimateBootstrapTokens(), exactMatchDictionary(), expandViaGraph(), formatLabeledInjectionContext(), getSessionContext(), handleBootstrap(), handleMessageReceived() (+12 more)

### Community 37 - "Community 37"
Cohesion: 0.16
Nodes (11): cloneEvent(), cloneFilterValue(), cloneRuleContext(), cloneSubscription(), matchesScalarFilter(), matchesSubscription(), normalizeFilter(), normalizeOptionalArray() (+3 more)

### Community 38 - "Community 38"
Cohesion: 0.24
Nodes (1): DictionaryService

### Community 39 - "Community 39"
Cohesion: 0.31
Nodes (14): addSessionMessage(), getSessionContext(), handleBootstrap(), handleMessageReceived(), kivoIntentInjectionHook(), loadHookApi(), log(), maybeSpawnExtractionWorker() (+6 more)

### Community 40 - "Community 40"
Cohesion: 0.2
Nodes (6): entryCountForSubject(), getArg(), getCount(), main(), resolveBackupPath(), runSeedCleanup()

### Community 41 - "Community 41"
Cohesion: 0.36
Nodes (2): CCITTFaxDecoder, CCITTFaxStream

### Community 42 - "Community 42"
Cohesion: 0.14
Nodes (1): ConnectionSetNamespace

### Community 43 - "Community 43"
Cohesion: 0.15
Nodes (1): UserStore

### Community 44 - "Community 44"
Cohesion: 0.15
Nodes (1): MockStorageProvider

### Community 45 - "Community 45"
Cohesion: 0.15
Nodes (1): XhtmlNamespace

### Community 46 - "Community 46"
Cohesion: 0.27
Nodes (3): formatConsistencyReport(), runConsistencyCheck(), ConsistencyChecker

### Community 47 - "Community 47"
Cohesion: 0.32
Nodes (11): chatJson(), deleteOrphanGraphNodes(), deletePlaceholderMaterials(), ensureUploadDir(), extractMp4Meta(), extractPdfText(), findOrCreateSubjectNode(), importOneMaterial() (+3 more)

### Community 48 - "Community 48"
Cohesion: 0.29
Nodes (1): JpegImage

### Community 49 - "Community 49"
Cohesion: 0.18
Nodes (2): NullOptimizer, QueueOptimizer

### Community 50 - "Community 50"
Cohesion: 0.2
Nodes (1): SQLiteMetricsCollector

### Community 51 - "Community 51"
Cohesion: 0.24
Nodes (2): ConflictResolutionLog, makeLogEntry()

### Community 52 - "Community 52"
Cohesion: 0.31
Nodes (6): generateConfigReference(), generateDocPackage(), generateQuickStart(), generateReadme(), generateTroubleshooting(), generateUpgradeGuide()

### Community 53 - "Community 53"
Cohesion: 0.27
Nodes (1): DomainAccessChecker

### Community 54 - "Community 54"
Cohesion: 0.38
Nodes (9): callLlm(), chunk(), cleanTitle(), fallbackTitle(), isDirtyTitle(), main(), normalizeBaseUrl(), parseJson() (+1 more)

### Community 55 - "Community 55"
Cohesion: 0.24
Nodes (4): mockUseApi(), mockUseApiLoading(), getSearchInput(), submitSearch()

### Community 56 - "Community 56"
Cohesion: 0.2
Nodes (1): Word64

### Community 57 - "Community 57"
Cohesion: 0.36
Nodes (7): assignRole(), isValidRole(), listRoles(), removeRole(), DELETE(), GET(), POST()

### Community 58 - "Community 58"
Cohesion: 0.36
Nodes (8): GET(), entryToActivityEvent(), formatRelative(), getDb(), getRecentActivityFromDb(), getRecentOperationLogActivity(), operationLogToActivityEvent(), operationTypeCondition()

### Community 59 - "Community 59"
Cohesion: 0.29
Nodes (1): PendingRepository

### Community 60 - "Community 60"
Cohesion: 0.44
Nodes (4): recommendActions(), buildNavigationState(), buildSidebar(), getDefaultRoute()

### Community 61 - "Community 61"
Cohesion: 0.25
Nodes (1): SessionManager

### Community 62 - "Community 62"
Cohesion: 0.39
Nodes (7): generateEmbedding(), llmComplete(), loadBetterSqlite3(), main(), normalizeBaseUrl(), resolveLlmConfig(), writeEntriesToDb()

### Community 63 - "Community 63"
Cohesion: 0.39
Nodes (8): classifyOne(), fallbackEntryType(), heuristicEntryType(), loadPenguinProvider(), looksLikeQuestion(), main(), parseCli(), runWithConcurrency()

### Community 64 - "Community 64"
Cohesion: 0.32
Nodes (1): MemoryStore

### Community 65 - "Community 65"
Cohesion: 0.54
Nodes (7): backfillSimilarSentences(), callLlm(), ensureDomainGoals(), generateResearchTasks(), getProvider(), main(), parseJsonArray()

### Community 66 - "Community 66"
Cohesion: 0.43
Nodes (7): ensureWhyColumns(), findDuplicateRows(), main(), markMetadata(), normalizeText(), parseArgs(), parseMetadata()

### Community 67 - "Community 67"
Cohesion: 0.25
Nodes (1): ToUnicodeMap

### Community 68 - "Community 68"
Cohesion: 0.38
Nodes (1): AuditLogger

### Community 71 - "Community 71"
Cohesion: 0.52
Nodes (5): loadReport(), parseReportItems(), safeJsonParse(), seedReport(), summarizeState()

### Community 75 - "Community 75"
Cohesion: 0.4
Nodes (2): highlightMatch(), toSearchEntries()

### Community 77 - "Community 77"
Cohesion: 0.7
Nodes (4): backfillDictEmbeddings(), deployHandler(), main(), verify()

### Community 81 - "Community 81"
Cohesion: 1.0
Nodes (4): main(), parseArgs(), tableExists(), ts()

### Community 82 - "Community 82"
Cohesion: 0.83
Nodes (3): apiFetch(), main(), sleep()

### Community 83 - "Community 83"
Cohesion: 0.67
Nodes (2): callLlm(), getProvider()

### Community 84 - "Community 84"
Cohesion: 0.5
Nodes (1): middleware()

### Community 88 - "Community 88"
Cohesion: 0.67
Nodes (2): findConflict(), resolveConflict()

### Community 93 - "Community 93"
Cohesion: 1.0
Nodes (2): createMinimalEntriesTable(), openDb()

## Knowledge Gaps
- **4 isolated node(s):** `Load the BGE model once and return it.`, `Encode a list of texts and return list of embedding vectors.`, `Original pipe mode: read JSON lines from stdin, write embeddings to stdout.`, `HTTP serve mode: proxy embedding requests to configured provider.`
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Community 32`** (26 nodes): `LocaleSetNamespace`, `.calendarSymbols()`, `.currencySymbol()`, `.currencySymbols()`, `.datePattern()`, `.datePatterns()`, `.dateTimeSymbols()`, `.day()`, `.dayNames()`, `.era()`, `.eraNames()`, `.locale()`, `.localeSet()`, `.meridiem()`, `.meridiemNames()`, `.month()`, `.monthNames()`, `.numberPattern()`, `.numberPatterns()`, `.numberSymbol()`, `.numberSymbols()`, `.timePattern()`, `.timePatterns()`, `.typeFace()`, `.typeFaces()`, `.[zr]()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 38`** (18 nodes): `DictionaryService`, `.buildEntry()`, `.constructor()`, `.deprecate()`, `.dictionaryFilter()`, `.emitChange()`, `.ensureAliasesUnique()`, `.ensureTermUniqueInScope()`, `.ensureUnique()`, `.getByTerm()`, `.listByScope()`, `.merge()`, `.offTermChange()`, `.onTermChange()`, `.queryAllActiveTerms()`, `.register()`, `.rollbackMerge()`, `.update()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 41`** (14 nodes): `CCITTFaxDecoder`, `._addPixels()`, `._addPixelsNeg()`, `.constructor()`, `._eatBits()`, `._findTableCode()`, `._getBlackCode()`, `._getTwoDimCode()`, `._getWhiteCode()`, `._lookBits()`, `.readNextChar()`, `CCITTFaxStream`, `.constructor()`, `.readBlock()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 42`** (14 nodes): `ConnectionSetNamespace`, `.connectionSet()`, `.effectiveInputPolicy()`, `.effectiveOutputPolicy()`, `.operation()`, `.rootElement()`, `.soapAction()`, `.soapAddress()`, `.uri()`, `.wsdlAddress()`, `.wsdlConnection()`, `.xmlConnection()`, `.xsdConnection()`, `.[zr]()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 43`** (13 nodes): `defaultHash()`, `defaultVerify()`, `UserStore`, `.authenticate()`, `.changePassword()`, `.constructor()`, `.createUser()`, `.disableUser()`, `.getUser()`, `.getUserByUsername()`, `.listUsers()`, `.updateRole()`, `user-store.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 44`** (13 nodes): `MockStorageProvider`, `.close()`, `.constructor()`, `.count()`, `.delete()`, `.findAll()`, `.findById()`, `.findByType()`, `.fullTextSearch()`, `.getVersionHistory()`, `.save()`, `.search()`, `.updateStatus()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 45`** (13 nodes): `XhtmlNamespace`, `.b()`, `.body()`, `.br()`, `.html()`, `.li()`, `.ol()`, `.p()`, `.span()`, `.sub()`, `.sup()`, `.ul()`, `.[zr]()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 48`** (12 nodes): `JpegImage`, `.constructor()`, `._convertCmykToRgb()`, `._convertCmykToRgba()`, `._convertYcckToCmyk()`, `._convertYcckToRgb()`, `._convertYcckToRgba()`, `._convertYccToRgb()`, `._convertYccToRgba()`, `.getData()`, `._getLinearizedBlockData()`, `._isColorConversionNeeded()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 49`** (12 nodes): `NullOptimizer`, `.constructor()`, `.flush()`, `._optimize()`, `.push()`, `.reset()`, `QueueOptimizer`, `.constructor()`, `.flush()`, `.isOffscreenCanvasSupported()`, `._optimize()`, `.reset()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 50`** (11 nodes): `SQLiteMetricsCollector`, `.aggregate()`, `.clear()`, `.constructor()`, `.getRawRecords()`, `.initSchema()`, `.recordConflict()`, `.recordDistribution()`, `.recordGapDetection()`, `.recordSearch()`, `sqlite-metrics-collector.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 51`** (11 nodes): `ConflictResolutionLog`, `.clear()`, `.count()`, `.getAll()`, `.getByConflictId()`, `.getByEntryId()`, `.record()`, `conflict-resolution-log.ts`, `conflict-resolution-log.test.ts`, `makeLogEntry()`, `conflict-resolution-log.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 53`** (10 nodes): `DomainAccessChecker`, `.canAccess()`, `.canResearch()`, `.constructor()`, `.filterEntries()`, `.getAccessibleDomains()`, `.getConfig()`, `.listRules()`, `.rebuildIndex()`, `.updateConfig()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 56`** (10 nodes): `Word64`, `.and()`, `.constructor()`, `.copyTo()`, `.not()`, `.or()`, `.rotateRight()`, `.shiftLeft()`, `.shiftRight()`, `.xor()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 59`** (10 nodes): `PendingRepository`, `.accept()`, `.assertSubjectUsable()`, `.buildBreadcrumb()`, `.constructor()`, `.fetchOrThrow()`, `.list()`, `.project()`, `.recordRejectionPreference()`, `.reject()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 61`** (9 nodes): `SessionManager`, `.constructor()`, `.create()`, `.getActiveSessions()`, `.invalidate()`, `.invalidateAllForUser()`, `.validate()`, `session-manager.ts`, `session-manager.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 64`** (8 nodes): `MemoryStore`, `.delete()`, `.deleteMany()`, `.get()`, `.query()`, `.save()`, `.saveMany()`, `.update()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 67`** (8 nodes): `ToUnicodeMap`, `.amend()`, `.charCodeOf()`, `.constructor()`, `.forEach()`, `.get()`, `.has()`, `.length()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 68`** (7 nodes): `AuditLogger`, `.constructor()`, `.count()`, `.log()`, `.query()`, `audit-logger.ts`, `audit-logger.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 75`** (6 nodes): `highlightMatch()`, `toDetailEntry()`, `toGraphSnapshot()`, `toKnowledgeListEntries()`, `toSearchEntries()`, `onboarding-knowledge.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 83`** (4 nodes): `callLlm()`, `getProvider()`, `finish-activation.mjs`, `parseJsonArray()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 84`** (4 nodes): `makeRequest()`, `middleware()`, `middleware.ts`, `middleware.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 88`** (4 nodes): `findConflict()`, `listConflicts()`, `resolveConflict()`, `conflicts-store.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 93`** (3 nodes): `createMinimalEntriesTable()`, `openDb()`, `research-registry-db.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `apiFetch()` connect `Community 5` to `Community 1`, `Community 3`?**
  _High betweenness centrality (0.101) - this node is a cross-community bridge._
- **Why does `TemplateNamespace` connect `Community 11` to `Community 0`, `Community 1`, `Community 15`?**
  _High betweenness centrality (0.098) - this node is a cross-community bridge._
- **Why does `warn()` connect `Community 1` to `Community 0`, `Community 8`, `Community 15`, `Community 18`, `Community 19`?**
  _High betweenness centrality (0.089) - this node is a cross-community bridge._
- **Are the 110 inferred relationships involving `serverError()` (e.g. with `GET()` and `PUT()`) actually correct?**
  _`serverError()` has 110 INFERRED edges - model-reasoned connections that need verification._
- **Are the 68 inferred relationships involving `badRequest()` (e.g. with `PUT()` and `DELETE()`) actually correct?**
  _`badRequest()` has 68 INFERRED edges - model-reasoned connections that need verification._
- **What connects `Load the BGE model once and return it.`, `Encode a list of texts and return list of embedding vectors.`, `Original pipe mode: read JSON lines from stdin, write embeddings to stdout.` to the rest of the system?**
  _4 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.0 - nodes in this community are weakly interconnected._