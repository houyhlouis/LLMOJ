// This file is generated automatically, do NOT modify it.

declare namespace ApiTypes {
  export interface AddJudgeClientRequestDto {
    name: string;
    allowedHosts: string[];
  }
  export interface AddJudgeClientResponseDto {
    error?: "PERMISSION_DENIED" | "REAUTHENTICATION_REQUIRED";
    judgeClient?: ApiTypes.JudgeClientInfoDto;
  }
  export interface AddProblemFileRequestDto {
    problemId: number;
    type: "TestData" | "AdditionalFile";
    filename: string;
    uploadInfo: ApiTypes.FileUploadInfoDto;
  }
  export interface AddProblemFileResponseDto {
    error?:
      | "NO_SUCH_PROBLEM"
      | "PERMISSION_DENIED"
      | "TOO_MANY_FILES"
      | "TOTAL_SIZE_TOO_LARGE"
      | "FILE_UUID_EXISTS"
      | "FILE_NOT_UPLOADED";
    signedUploadRequest?: ApiTypes.SignedFileUploadRequestDto;
  }
  export interface AddUserToGroupRequestDto {
    userId: number;
    groupId: number;
  }
  export interface AddUserToGroupResponseDto {
    error?: "PERMISSION_DENIED" | "NO_SUCH_USER" | "NO_SUCH_GROUP" | "USER_ALREADY_IN_GROUP";
  }
  export interface AiApprovedEndpointDto {
    /**
     * Shown to users who choose it.
     */
    name: string;
    /**
     * The API it speaks.
     */
    type: "chat" | "responses" | "anthropic" | "tavily" | "mcp";
    /**
     * Requests with this origin, at or below this path, are approved.
     */
    baseUrl: string;
  }
  export interface AiEndpointPolicyDto {
    /**
     * Whether accounts may use public addresses that aren't approved. Private ones always need approval.
     */
    customEndpoints: "public" | "approved";
    endpoints: ApiTypes.AiApprovedEndpointDto[];
  }
  export interface AiJobIdDto {
    id: string;
  }
  export interface AiJobQueryDto {
    problemId?: number;
  }
  export interface AiPolicyDto {
    /**
     * No AI provider request starts while paused.
     */
    paused: boolean;
    /**
     * Tokens per account in any 24 hours; 0 for no limit.
     */
    userDailyTokens: number;
    /**
     * Model and search requests per account in any 24 hours; 0 for no limit.
     */
    userDailyRequests: number;
    /**
     * Model and search requests per AI job; 0 for no limit.
     */
    jobRequests: number;
    /**
     * AI provider requests running at the same time in one backend process.
     */
    concurrentRequests: number;
  }
  export interface AiPrepareAttachmentDto {
    filename: string;
    size: number;
  }
  export interface AiRetryJobDto {
    id: string;
    retryFrom?: "validate-samples" | "std";
  }
  export interface AiTestDto {
    target: "llm" | "search";
  }
  export interface AiUsageQueryDto {
    days?: number;
  }
  export interface ArchiveNameMapDto {
    archivePath: string;
    filename: string;
  }
  export interface ArchiveTestcaseDto {
    inputFile: string;
    outputFile: string;
  }
  export interface BeginPasskeyRegistrationResponseDto {
    error?:
      | "PERMISSION_DENIED"
      | "NO_SUCH_USER"
      | "ALREADY_LOGGEDIN"
      | "REAUTHENTICATION_REQUIRED"
      | "WRONG_PASSWORD"
      | "REGISTRATION_PENDING"
      | "REGISTRATION_REJECTED"
      | "ALREADY_ENABLED"
      | "NOT_ENABLED"
      | "SETUP_EXPIRED"
      | "INVALID_CODE"
      | "INVALID_PASSKEY"
      | "PASSKEY_UNAVAILABLE"
      | "TOO_MANY_PASSKEYS"
      | "NO_SUCH_PASSKEY"
      | "CHALLENGE_EXPIRED"
      | "TOO_MANY_ATTEMPTS";
    /**
     * PublicKeyCredentialCreationOptions with base64url binary fields.
     */
    options?: {
      [name: string]: any;
    };
  }
  export interface BeginTotpSetupResponseDto {
    error?:
      | "PERMISSION_DENIED"
      | "NO_SUCH_USER"
      | "ALREADY_LOGGEDIN"
      | "REAUTHENTICATION_REQUIRED"
      | "WRONG_PASSWORD"
      | "REGISTRATION_PENDING"
      | "REGISTRATION_REJECTED"
      | "ALREADY_ENABLED"
      | "NOT_ENABLED"
      | "SETUP_EXPIRED"
      | "INVALID_CODE"
      | "INVALID_PASSKEY"
      | "PASSKEY_UNAVAILABLE"
      | "TOO_MANY_PASSKEYS"
      | "NO_SUCH_PASSKEY"
      | "CHALLENGE_EXPIRED"
      | "TOO_MANY_ATTEMPTS";
    secret?: string;
    /**
     * otpauth:// URI for authenticator apps
     */
    uri?: string;
  }
  export interface CancelSubmissionRequestDto {
    submissionId: number;
  }
  export interface CancelSubmissionResponseDto {
    error?: "NO_SUCH_SUBMISSION" | "PERMISSION_DENIED";
  }
  export interface ChangeProblemTypeRequestDto {
    problemId: number;
    type: "Traditional" | "Interaction" | "SubmitAnswer" | "Communication";
  }
  export interface ChangeProblemTypeResponseDto {
    error?: "NO_SUCH_PROBLEM" | "PERMISSION_DENIED" | "PROBLEM_HAS_SUBMISSION";
  }
  export interface CheckAvailabilityResponseDto {
    usernameAvailable?: boolean;
    emailAvailable?: boolean;
  }
  export interface CompleteTwoFactorLoginRequestDto {
    totpCode?: string;
    recoveryCode?: string;
    passkey?: ApiTypes.PasskeyAssertionDto;
    challenge: string;
  }
  export interface CompleteTwoFactorLoginResponseDto {
    error?:
      | "PERMISSION_DENIED"
      | "NO_SUCH_USER"
      | "ALREADY_LOGGEDIN"
      | "REAUTHENTICATION_REQUIRED"
      | "WRONG_PASSWORD"
      | "REGISTRATION_PENDING"
      | "REGISTRATION_REJECTED"
      | "ALREADY_ENABLED"
      | "NOT_ENABLED"
      | "SETUP_EXPIRED"
      | "INVALID_CODE"
      | "INVALID_PASSKEY"
      | "PASSKEY_UNAVAILABLE"
      | "TOO_MANY_PASSKEYS"
      | "NO_SUCH_PASSKEY"
      | "CHALLENGE_EXPIRED"
      | "TOO_MANY_ATTEMPTS";
    token?: string;
    username?: string;
  }
  export interface ConfirmTotpSetupRequestDto {
    code: string; // ^\d{6}$
  }
  export interface ContestRequestDto {
    id?: number;
    problemId?: number;
    submissionId?: number;
    page?: number;
    data?: {};
  }
  export interface CreateDiscussionReplyRequestDto {
    discussionId: number;
    content: string;
    isPublic?: boolean;
  }
  export interface CreateDiscussionReplyResponseDto {
    error?: "PERMISSION_DENIED" | "NO_SUCH_DISCUSSION";
    reply?: ApiTypes.DiscussionReplyDto;
  }
  export interface CreateDiscussionRequestDto {
    type?: "Discussion" | "Solution";
    problemId?: number;
    title: string;
    content: string;
    isPublic?: boolean;
  }
  export interface CreateDiscussionResponseDto {
    error?: "SOLUTION_REQUIRES_PROBLEM" | "PERMISSION_DENIED" | "NO_SUCH_PROBLEM";
    discussionId?: number;
  }
  export interface CreateGroupRequestDto {
    groupName: string;
  }
  export interface CreateGroupResponseDto {
    error?: "PERMISSION_DENIED" | "DUPLICATE_GROUP_NAME";
    groupId?: number;
  }
  export interface CreateProblemRequestDto {
    type: "Traditional" | "Interaction" | "SubmitAnswer" | "Communication";
    statement: ApiTypes.ProblemStatementDto;
  }
  export interface CreateProblemResponseDto {
    error?: "PERMISSION_DENIED" | "NO_SUCH_PROBLEM_TAG" | "FAILED";
    id?: number;
  }
  export interface CreateProblemTagRequestDto {
    localizedNames: ApiTypes.ProblemTagLocalizedNameDto[];
    color: string;
  }
  export interface CreateProblemTagResponseDto {
    error?: "PERMISSION_DENIED";
    id?: number;
  }
  export interface DeleteDiscussionReplyRequestDto {
    discussionReplyId: number;
  }
  export interface DeleteDiscussionReplyResponseDto {
    error?: "PERMISSION_DENIED" | "NO_SUCH_DISCUSSION_REPLY";
  }
  export interface DeleteDiscussionRequestDto {
    discussionId: number;
  }
  export interface DeleteDiscussionResponseDto {
    error?: "PERMISSION_DENIED" | "NO_SUCH_DISCUSSION";
  }
  export interface DeleteGroupRequestDto {
    groupId: number;
  }
  export interface DeleteGroupResponseDto {
    error?: "PERMISSION_DENIED" | "NO_SUCH_GROUP";
  }
  export interface DeleteJudgeClientRequestDto {
    id: number;
  }
  export interface DeleteJudgeClientResponseDto {
    error?: "PERMISSION_DENIED" | "NO_SUCH_JUDGE_CLIENT" | "REAUTHENTICATION_REQUIRED";
  }
  export interface DeleteProblemRequestDto {
    problemId: number;
  }
  export interface DeleteProblemResponseDto {
    error?: "PERMISSION_DENIED" | "NO_SUCH_PROBLEM";
  }
  export interface DeleteProblemTagRequestDto {
    id: number;
  }
  export interface DeleteProblemTagResponseDto {
    error?: "NO_SUCH_PROBLEM_TAG" | "PERMISSION_DENIED";
  }
  export interface DeleteSubmissionRequestDto {
    submissionId: number;
  }
  export interface DeleteSubmissionResponseDto {
    error?: "NO_SUCH_SUBMISSION" | "PERMISSION_DENIED";
  }
  export interface DiscussionDto {
    meta: ApiTypes.DiscussionMetaDto;
    content: string;
    problem?: ApiTypes.GetDiscussionAndRepliesResponseProblemDto;
    publisher: ApiTypes.UserMetaDto;
    reactions: ApiTypes.DiscussionOrReplyReactionsDto;
    permissions: ("View" | "Modify" | "ManagePermission" | "ManagePublicness" | "Delete")[];
  }
  export interface DiscussionGroupPermissionDto {
    group: ApiTypes.GroupMetaDto;
    permissionLevel: 1 | 2;
  }
  export interface DiscussionMetaDto {
    type: "Discussion" | "Solution";
    id: number;
    title: string;
    publishTime: string; // date-time
    editTime: string; // date-time
    sortTime: string; // date-time
    replyCount: number;
    isPublic: boolean;
    publisherId: number;
    problemId?: number;
  }
  export interface DiscussionOrReplyReactionsDto {
    count: {
      [name: string]: number;
    };
    currentUserReactions: string[];
  }
  export interface DiscussionPermissionsDto {
    userPermissions: ApiTypes.DiscussionUserPermissionDto[];
    groupPermissions: ApiTypes.DiscussionGroupPermissionDto[];
  }
  export interface DiscussionReplyDto {
    id: number;
    content: string;
    publishTime: string; // date-time
    editTime: string; // date-time
    isPublic: boolean;
    publisher: ApiTypes.UserMetaDto;
    reactions: ApiTypes.DiscussionOrReplyReactionsDto;
    /**
     * ManagePermission is not valid for replies.
     */
    permissions: ("View" | "Modify" | "ManagePermission" | "ManagePublicness" | "Delete")[];
  }
  export interface DiscussionUserPermissionDto {
    user: ApiTypes.UserMetaDto;
    permissionLevel: 1 | 2;
  }
  export interface DownloadProblemFilesRequestDto {
    problemId: number;
    type: "TestData" | "AdditionalFile";
    filenameList: string[];
  }
  export interface DownloadProblemFilesResponseDto {
    error?: "NO_SUCH_PROBLEM" | "PERMISSION_DENIED";
    downloadInfo?: ApiTypes.ProblemFileDownloadInfoDto[];
  }
  export interface DownloadSubmissionFileRequestDto {
    submissionId: number;
    filename: string;
  }
  export interface DownloadSubmissionFileResponseDto {
    error?: "NO_SUCH_SUBMISSION" | "NO_SUCH_FILE" | "PERMISSION_DENIED";
    url?: string;
  }
  export interface FakeSubmissionRequestDto {
    submissionId: number;
  }
  export interface FakeSubmissionResponseDto {
    error?: "NO_SUCH_SUBMISSION" | "PERMISSION_DENIED";
  }
  export interface FileUploadInfoDto {
    uuid?: string; // uuid
    size: number;
  }
  export interface FinishPasskeyRegistrationRequestDto {
    name: string;
    credential: ApiTypes.PasskeyRegistrationDto;
  }
  export interface GetAllProblemTagsOfAllLocalesResponseDto {
    error?: "PERMISSION_DENIED";
    tags?: ApiTypes.ProblemTagWithAllLocalesDto[];
  }
  export interface GetAllProblemTagsRequestDto {
    locale: "en_US" | "zh_CN";
  }
  export interface GetAllProblemTagsResponseDto {
    tags: ApiTypes.LocalizedProblemTagDto[];
  }
  export interface GetDiscussionAndRepliesRequestDto {
    locale: "en_US" | "zh_CN";
    discussionId: number;
    /**
     * `HeadTail` is for the first query of a discussion page while `IdRange` is for loading the ramaining.
     */
    queryRepliesType?: "HeadTail" | "IdRange";
    getDiscussion?: boolean;
    /**
     * Only valid for `queryRepliesType` = `HeadTail`. Omitted means no replies from this end.
     */
    headTakeCount?: number;
    /**
     * Only valid for `queryRepliesType` = `HeadTail`. Omitted means no replies from this end.
     */
    tailTakeCount?: number;
    /**
     * Only valid for `type` = `IdRange`.
     */
    beforeId?: number;
    /**
     * Only valid for `type` = `IdRange`.
     */
    afterId?: number;
    /**
     * Only valid for `queryRepliesType` = `IdRange`. Omitted means no replies.
     */
    idRangeTakeCount?: number;
  }
  export interface GetDiscussionAndRepliesResponseDto {
    error?: "NO_SUCH_DISCUSSION" | "PERMISSION_DENIED" | "TAKE_TOO_MANY";
    discussion?: ApiTypes.DiscussionDto;
    /**
     * Only valid for `type` = `HeadTail`.
     */
    repliesHead?: ApiTypes.DiscussionReplyDto[];
    /**
     * Only valid for `type` = `HeadTail`.
     */
    repliesTail?: ApiTypes.DiscussionReplyDto[];
    /**
     * Only valid for `type` = `HeadTail`.
     */
    repliesTotalCount?: number;
    /**
     * Only valid for `type` = `IdRange`.
     */
    repliesInRange?: ApiTypes.DiscussionReplyDto[];
    /**
     * Only valid for `type` = `IdRange`.
     */
    repliesCountInRange?: number;
    permissionCreateNewDiscussion?: boolean;
  }
  export interface GetDiscussionAndRepliesResponseProblemDto {
    meta: ApiTypes.ProblemMetaDto;
    title: string;
    titleLocale: "en_US" | "zh_CN";
  }
  export interface GetDiscussionPermissionsRequestDto {
    id: number;
  }
  export interface GetDiscussionPermissionsResponseDto {
    error?: "PERMISSION_DENIED" | "NO_SUCH_DISCUSSION";
    permissions?: ApiTypes.DiscussionPermissionsDto;
    haveManagePermissionsPermission?: boolean;
  }
  export interface GetGroupListResponseDto {
    groups: ApiTypes.GroupMetaDto[];
    groupsWithAdminPermission: number[];
  }
  export interface GetGroupMemberListRequestDto {
    groupId: number;
  }
  export interface GetGroupMemberListResponseDto {
    error?: "NO_SUCH_GROUP" | "PERMISSION_DENIED";
    memberList?: ApiTypes.GetGroupMemberListResponseItem[];
  }
  export interface GetGroupMemberListResponseItem {
    userMeta: ApiTypes.UserMetaDto;
    isGroupAdmin: boolean;
  }
  export interface GetGroupMetaResponseDto {
    error?: "NO_SUCH_GROUP";
    groupMeta?: ApiTypes.GroupMetaDto;
  }
  export interface GetHomepageResponseDto {
    notice: string;
    noticeLocale: "en_US" | "zh_CN";
    annnouncements: ApiTypes.DiscussionMetaDto[];
    annnouncementsLocale: "en_US" | "zh_CN";
    hitokoto?: ApiTypes.HomepageSettingsHitokoto;
    countdown?: ApiTypes.HomepageSettingsCountdown;
    friendLinks?: ApiTypes.HomepageSettingsFriendLinks;
    topUsers: ApiTypes.UserMetaDto[];
    latestUpdatedProblems: ApiTypes.GetHomepageResponseProblemDto[];
  }
  export interface GetHomepageResponseProblemDto {
    meta: ApiTypes.ProblemMetaDto;
    title: string;
    submission: ApiTypes.SubmissionBasicMetaDto;
  }
  export interface GetHomepageSettingsResponseDto {
    error?: "PERMISSION_DENIED";
    settings?: ApiTypes.HomepageSettings;
    annnouncementDiscussions?: ApiTypes.DiscussionMetaDto[];
  }
  export interface GetJudgeClientKeyRequestDto {
    id: number;
  }
  export interface GetJudgeClientKeyResponseDto {
    error?: "PERMISSION_DENIED" | "NO_SUCH_JUDGE_CLIENT" | "REAUTHENTICATION_REQUIRED";
    key?: string;
  }
  export interface GetJudgeQueueStatusResponseDto {
    error?: "PERMISSION_DENIED";
    status?: ApiTypes.JudgeQueueStatusDto;
  }
  export interface GetPermissionsDto {}
  export interface GetProblemRequestDto {
    id?: number;
    displayId?: number;
    owner?: boolean;
    localizedContentsOfLocale?: "en_US" | "zh_CN";
    localizedContentsTitleOnly?: boolean;
    localizedContentsOfAllLocales?: boolean;
    tagsOfLocale?: "en_US" | "zh_CN";
    tagsOfAllLocales?: boolean;
    samples?: boolean;
    judgeInfo?: boolean;
    judgeInfoToBePreprocessed?: boolean;
    testData?: boolean;
    additionalFiles?: boolean;
    statistics?: boolean;
    discussionCount?: boolean;
    permissionOfCurrentUser?: boolean;
    permissions?: boolean;
    lastSubmissionAndLastAcceptedSubmission?: boolean;
  }
  export interface GetProblemResponseDto {
    error?: "PERMISSION_DENIED" | "NO_SUCH_PROBLEM";
    meta?: ApiTypes.ProblemMetaDto;
    owner?: ApiTypes.UserMetaDto;
    localizedContentsOfLocale?: ApiTypes.ProblemLocalizedContentDto;
    localizedContentsOfAllLocales?: ApiTypes.ProblemLocalizedContentDto[];
    tagsOfLocale?: ApiTypes.LocalizedProblemTagDto[];
    tagsOfAllLocales?: ApiTypes.ProblemTagWithAllLocalesDto[];
    samples?: ApiTypes.ProblemSampleDataMemberDto[];
    judgeInfo?: {};
    submittable?: boolean;
    testData?: ApiTypes.ProblemFileDto[];
    additionalFiles?: ApiTypes.ProblemFileDto[];
    discussionCount?: number;
    solutionCount?: number;
    permissionOfCurrentUser?: ("View" | "Modify" | "ManagePermission" | "ManagePublicness" | "Delete")[];
    permissions?: ApiTypes.ProblemPermissionsDto;
    lastSubmission?: ApiTypes.ProblemLastSubmissionDto;
  }
  export interface GetProblemTagDetailRequestDto {
    id: number;
  }
  export interface GetProblemTagDetailResponseDto {
    error?: "NO_SUCH_PROBLEM_TAG";
    id?: number;
    color?: string;
    localizedNames?: ApiTypes.ProblemTagLocalizedNameDto[];
  }
  export interface GetReauthenticationOptionsResponseDto {
    error?:
      | "PERMISSION_DENIED"
      | "NO_SUCH_USER"
      | "ALREADY_LOGGEDIN"
      | "REAUTHENTICATION_REQUIRED"
      | "WRONG_PASSWORD"
      | "REGISTRATION_PENDING"
      | "REGISTRATION_REJECTED"
      | "ALREADY_ENABLED"
      | "NOT_ENABLED"
      | "SETUP_EXPIRED"
      | "INVALID_CODE"
      | "INVALID_PASSKEY"
      | "PASSKEY_UNAVAILABLE"
      | "TOO_MANY_PASSKEYS"
      | "NO_SUCH_PASSKEY"
      | "CHALLENGE_EXPIRED"
      | "TOO_MANY_ATTEMPTS";
    /**
     * Present when the account uses two-factor sign-in.
     */
    twoFactor?: {
      /**
       * Single-use, expires after 5 minutes.
       */
      token: string;
      methods: ("totp" | "passkey" | "recoveryCode")[];
      /**
       * PublicKeyCredentialRequestOptions with base64url binary fields.
       */
      passkey?: {
        [name: string]: any;
      };
    };
  }
  export interface GetSessionInfoResponseDto {
    userMeta?: ApiTypes.UserMetaDto;
    joinedGroupsCount?: number;
    userPrivileges?: (
      | "EditHomepage"
      | "ManageUser"
      | "ManageUserGroup"
      | "ManageProblem"
      | "ManageContest"
      | "ManageDiscussion"
      | "ViewSite"
      | "ViewUsers"
      | "EditOwnProfile"
      | "ViewPrivateUserInfo"
      | "CreateGroup"
      | "ViewProblem"
      | "ViewHiddenProblem"
      | "CreateProblem"
      | "EditOwnProblem"
      | "EditAnyProblem"
      | "DeleteOwnProblem"
      | "DeleteAnyProblem"
      | "ManageProblemPermissions"
      | "ManageProblemVisibility"
      | "ManageProblemTags"
      | "ReadProblemData"
      | "EditProblemData"
      | "DownloadProblemAttachments"
      | "SubmitProblem"
      | "ViewSubmission"
      | "ReadAnySubmissionCode"
      | "ReadCodeAfterAccepted"
      | "RejudgeSubmission"
      | "DeleteSubmission"
      | "ViewDiscussion"
      | "CreateDiscussion"
      | "EditOwnDiscussion"
      | "EditAnyDiscussion"
      | "DeleteOwnDiscussion"
      | "DeleteAnyDiscussion"
      | "ReplyDiscussion"
      | "ReactDiscussion"
      | "EditOwnReply"
      | "ManageDiscussionReplies"
      | "ViewContest"
      | "ViewHiddenContest"
      | "CreateContest"
      | "EditContest"
      | "ParticipateContest"
      | "ViewContestScoreboard"
      | "ViewHiddenContestScoreboard"
      | "ExportContest"
      | "ManageSummaries"
      | "ManageStudyLists"
      | "ManageAiConfiguration"
      | "UseAi"
      | "GenerateTestdata"
      | "ImportProblem"
      | "ManagePermissions"
      | "SkipRecaptcha"
      | "ManageRegistrationReviews"
      | "ViewTeam"
      | "CreateTeam"
      | "ManageTeams"
      | "FakeSubmission"
      | "ViewHack"
      | "CreateHack"
      | "ManageHack"
      | "CreateSelfEval"
    )[];
    userPreference?: ApiTypes.UserPreferenceDto;
    serverPreference: ApiTypes.PreferenceConfig;
    serverVersion: ApiTypes.ServerVersionDto;
    sessionMarker?: string;
  }
  export interface GetSubmissionDetailRequestDto {
    submissionId: string;
    locale: "en_US" | "zh_CN";
  }
  export interface GetSubmissionDetailResponseDto {
    error?: "NO_SUCH_SUBMISSION" | "PERMISSION_DENIED";
    meta?: ApiTypes.SubmissionMetaDto;
    content?: {};
    progress?: {};
    progressSubscriptionKey?: string;
    permissionRejudge?: boolean;
    permissionCancel?: boolean;
    permissionSetPublic?: boolean;
    permissionDelete?: boolean;
    permissionFake?: boolean;
    /**
     * With rejudge permission; absent for submissions from before data versions
     */
    dataVersion?: {
      /**
       * The problem's data version number the submission is (being) judged with
       */
      version: number;
      /**
       * Whether the problem's test data and judge settings are still that version
       */
      current: boolean;
      /**
       * Whether its test data is all still there
       */
      testData: {
        /**
         * InUse: the problem uses all of it; Retained: some was removed from the problem but is kept; Deleted: some is gone, so results judged with it can't be judged again with the same data
         */
        state: "InUse" | "Retained" | "Deleted";
        /**
         * Retained: when the first of its removed files may be deleted; absent while kept as long as needed
         */
        retainedUntil?: string; // date-time
        /**
         * Retained: the next cleanup, within ten minutes, deletes some of it
         */
        deletionDue?: boolean;
        /**
         * Retained: why
         */
        reasons?: (
          | "Grace"
          | "WaitingSubmission"
          | "WaitingHack"
          | "WaitingSelfEval"
          | "Contest"
          | "Result"
          | "EarlierResult"
          | "Kept"
        )[];
        /**
         * Who chose to keep it until released; absent if nobody did
         */
        keptBy?: string;
        keptAt?: string; // date-time
      };
    };
    /**
     * With rejudge permission: what its result was judged with; absent if not recorded
     */
    judgeRuntime?: {
      /**
       * SHA-256 of the judge program's source files
       */
      judgeProgram: string;
      /**
       * The sandbox image (rootfs) ID, which identifies its compilers and interpreters
       */
      sandboxImage: string;
      /**
       * The Node.js version
       */
      node: string;
      os: string;
      kernel: string;
      arch: string;
      cpu: string;
      /**
       * The judge machine's name now; null if it was deleted
       */
      judgeMachine?: string;
    };
    /**
     * With rejudge permission: results rejudges replaced, the most recent first
     */
    earlierResults?: ApiTypes.SubmissionEarlierResultDto[];
  }
  export interface GetTencentCaptchaAppIdResponseDto {
    appId: string;
    encryptedAppId: string;
    encryptedAppIdType: "gcm";
  }
  export interface GetTwoFactorStatusRequestDto {
    userId: number;
  }
  export interface GetTwoFactorStatusResponseDto {
    error?:
      | "PERMISSION_DENIED"
      | "NO_SUCH_USER"
      | "ALREADY_LOGGEDIN"
      | "REAUTHENTICATION_REQUIRED"
      | "WRONG_PASSWORD"
      | "REGISTRATION_PENDING"
      | "REGISTRATION_REJECTED"
      | "ALREADY_ENABLED"
      | "NOT_ENABLED"
      | "SETUP_EXPIRED"
      | "INVALID_CODE"
      | "INVALID_PASSKEY"
      | "PASSKEY_UNAVAILABLE"
      | "TOO_MANY_PASSKEYS"
      | "NO_SUCH_PASSKEY"
      | "CHALLENGE_EXPIRED"
      | "TOO_MANY_ATTEMPTS";
    status?: ApiTypes.TwoFactorStatusDto;
  }
  export interface GetUserDetailRequestDto {
    userId?: number;
    username?: string;
    timezone: string;
    now: string;
  }
  export interface GetUserDetailResponseDto {
    error?: "NO_SUCH_USER";
    meta?: ApiTypes.UserMetaDto;
    information?: ApiTypes.UserInformationDto;
    submissionCountPerDay?: number[];
    rank?: number;
    hasPrivilege?: boolean;
  }
  export interface GetUserListRequestDto {
    sortBy: "acceptedProblemCount" | "rating";
    skipCount: number;
    takeCount: number;
  }
  export interface GetUserListResponseDto {
    error?: "TAKE_TOO_MANY";
    userMetas?: ApiTypes.UserMetaDto[];
    count?: number;
  }
  export interface GetUserMetaRequestDto {
    userId?: number;
    username?: string;
    getPrivileges?: boolean;
  }
  export interface GetUserMetaResponseDto {
    error?: "NO_SUCH_USER";
    meta?: ApiTypes.UserMetaDto;
    privileges?: (
      | "EditHomepage"
      | "ManageUser"
      | "ManageUserGroup"
      | "ManageProblem"
      | "ManageContest"
      | "ManageDiscussion"
      | "ViewSite"
      | "ViewUsers"
      | "EditOwnProfile"
      | "ViewPrivateUserInfo"
      | "CreateGroup"
      | "ViewProblem"
      | "ViewHiddenProblem"
      | "CreateProblem"
      | "EditOwnProblem"
      | "EditAnyProblem"
      | "DeleteOwnProblem"
      | "DeleteAnyProblem"
      | "ManageProblemPermissions"
      | "ManageProblemVisibility"
      | "ManageProblemTags"
      | "ReadProblemData"
      | "EditProblemData"
      | "DownloadProblemAttachments"
      | "SubmitProblem"
      | "ViewSubmission"
      | "ReadAnySubmissionCode"
      | "ReadCodeAfterAccepted"
      | "RejudgeSubmission"
      | "DeleteSubmission"
      | "ViewDiscussion"
      | "CreateDiscussion"
      | "EditOwnDiscussion"
      | "EditAnyDiscussion"
      | "DeleteOwnDiscussion"
      | "DeleteAnyDiscussion"
      | "ReplyDiscussion"
      | "ReactDiscussion"
      | "EditOwnReply"
      | "ManageDiscussionReplies"
      | "ViewContest"
      | "ViewHiddenContest"
      | "CreateContest"
      | "EditContest"
      | "ParticipateContest"
      | "ViewContestScoreboard"
      | "ViewHiddenContestScoreboard"
      | "ExportContest"
      | "ManageSummaries"
      | "ManageStudyLists"
      | "ManageAiConfiguration"
      | "UseAi"
      | "GenerateTestdata"
      | "ImportProblem"
      | "ManagePermissions"
      | "SkipRecaptcha"
      | "ManageRegistrationReviews"
      | "ViewTeam"
      | "CreateTeam"
      | "ManageTeams"
      | "FakeSubmission"
      | "ViewHack"
      | "CreateHack"
      | "ManageHack"
      | "CreateSelfEval"
    )[];
  }
  export interface GetUserPreferenceRequestDto {
    userId?: number;
    username?: string;
  }
  export interface GetUserPreferenceResponseDto {
    error?: "NO_SUCH_USER" | "PERMISSION_DENIED";
    meta?: ApiTypes.UserMetaDto;
    preference?: ApiTypes.UserPreferenceDto;
  }
  export interface GetUserProfileRequestDto {
    userId?: number;
    username?: string;
  }
  export interface GetUserProfileResponseDto {
    error?: "NO_SUCH_USER" | "PERMISSION_DENIED";
    meta?: ApiTypes.UserMetaDto;
    publicEmail?: boolean;
    avatarInfo?: string;
    information?: ApiTypes.UserInformationDto;
  }
  export interface GetUserSecuritySettingsRequestDto {
    userId?: number;
    username?: string;
  }
  export interface GetUserSecuritySettingsResponseDto {
    error?: "NO_SUCH_USER" | "PERMISSION_DENIED";
    meta?: ApiTypes.UserMetaDto;
  }
  export interface GroupMetaDto {
    id: number;
    name: string;
    memberCount: number;
  }
  export interface HackRequestDto {
    mine?: string;
    id?: number;
    problemId?: number;
    submissionId?: number;
    contestId?: number;
    hackerId?: number;
    page?: number;
    hacker?: string;
    status?: string;
    inputData?: string;
    referenceSubmissionId?: number;
    standardCode?: string;
    standardLanguage?: string;
    standardCompileAndRunOptions?: {
      [name: string]: string;
    };
    standardFileIo?: {
      inputFilename: string;
      outputFilename: string;
    };
    validatorCode?: string;
    validatorLanguage?: string;
  }
  export interface HeaderParameters {
    "X-Proof-Of-Work": ApiTypes.Parameters.XProofOfWork;
  }
  export interface HomepageSettings {
    notice: ApiTypes.HomepageSettingsNotice;
    annnouncements: ApiTypes.HomepageSettingsAnnouncements;
    hitokoto: ApiTypes.HomepageSettingsHitokoto;
    countdown: ApiTypes.HomepageSettingsCountdown;
    friendLinks: ApiTypes.HomepageSettingsFriendLinks;
  }
  export interface HomepageSettingsAnnouncements {
    items: {};
  }
  export interface HomepageSettingsCountdown {
    enabled: boolean;
    items: {};
  }
  export interface HomepageSettingsFriendLinks {
    enabled: boolean;
    links: {};
  }
  export interface HomepageSettingsHitokoto {
    enabled: boolean;
    apiUrl: string;
    customTitle: string;
  }
  export interface HomepageSettingsNotice {
    enabled: boolean;
    contents: {};
  }
  export interface ImportTestDataZipRequestDto {
    problemId: number;
    filename: string;
    uploadInfo: ApiTypes.FileUploadInfoDto;
    replaceExisting?: boolean;
  }
  export interface ImportTestDataZipResponseDto {
    error?: string;
    signedUploadRequest?: ApiTypes.SignedFileUploadRequestDto;
    importedFiles?: ApiTypes.ProblemFileDto[];
    detectedTestcases?: ApiTypes.ArchiveTestcaseDto[];
    nameMap?: ApiTypes.ArchiveNameMapDto[];
    skippedFiles?: string[];
  }
  export interface IssueProofOfWorkChallengeRequestDto {
    action:
      | "login"
      | "email_verification"
      | "register"
      | "reset_password"
      | "create_discussion"
      | "reply_discussion"
      | "create_problem"
      | "add_problem_file"
      | "prepare_submission_file_upload"
      | "submit_problem"
      | "acquire_tencent_captcha";
  }
  export interface IssueProofOfWorkChallengeResponseDto {
    id: string;
    randomData: string;
    difficulty: number;
    expiresAt: number;
  }
  export interface JudgeClientCapabilitiesDto {
    protocolVersion: number;
    /**
     * The task types it is sent
     */
    taskTypes: string[];
    consumerThreads: number;
    executionSlots: number;
    /**
     * MiB the sandboxes of concurrent work may reserve together
     */
    memoryBudget: number;
    aiExecutionSlots: number;
    /**
     * What it judges with; absent for judge clients older than protocol version 3
     */
    runtime?: {
      /**
       * SHA-256 of the judge program's source files
       */
      judgeProgram: string;
      /**
       * The sandbox image (rootfs) ID, which identifies its compilers and interpreters
       */
      sandboxImage: string;
      /**
       * The Node.js version
       */
      node: string;
      os: string;
      kernel: string;
      arch: string;
      cpu: string;
    };
  }
  export interface JudgeClientInfoDto {
    id: number;
    name: string;
    key: string;
    allowedHosts: string[];
    online: boolean;
    systemInfo?: {};
    /**
     * Sent no new tasks; finishes the ones it has
     */
    draining: boolean;
    /**
     * Tasks it is judging now
     */
    runningTasks: number;
    /**
     * What it announced when it last connected; absent for judge clients older than protocol version 2
     */
    capabilities?: {
      protocolVersion: number;
      /**
       * The task types it is sent
       */
      taskTypes: string[];
      consumerThreads: number;
      executionSlots: number;
      /**
       * MiB the sandboxes of concurrent work may reserve together
       */
      memoryBudget: number;
      aiExecutionSlots: number;
      /**
       * What it judges with; absent for judge clients older than protocol version 3
       */
      runtime?: {
        /**
         * SHA-256 of the judge program's source files
         */
        judgeProgram: string;
        /**
         * The sandbox image (rootfs) ID, which identifies its compilers and interpreters
         */
        sandboxImage: string;
        /**
         * The Node.js version
         */
        node: string;
        os: string;
        kernel: string;
        arch: string;
        cpu: string;
      };
    };
  }
  export interface JudgeJobInfoDto {
    taskId: string;
    /**
     * Submission, Hack, SelfEvalPrepare or SelfEval
     */
    type: string;
    state: "Queued" | "Leased" | "Failed";
    createdAt: string; // date-time
    /**
     * The judge client of the current or last lease
     */
    judgeClientId?: number;
    /**
     * How many times the task has been sent to a judge client
     */
    fence: number;
    /**
     * Leases that ended without a result
     */
    unfinishedLeases: number;
    preparationFailures: number;
    lastError?: string;
    finishedAt?: string; // date-time
  }
  export interface JudgePolicyDto {
    /**
     * Task threads each judge machine keeps for submissions to running contests while one runs; 0 keeps none.
     */
    contestReservedThreads: number;
    /**
     * Minutes after which a waiting job gets every fifth task; 0 turns this off.
     */
    agingMinutes: number;
  }
  export interface JudgeQueueStatusDto {
    queued: number;
    /**
     * Being judged
     */
    leased: number;
    /**
     * Given up on in the last 7 days
     */
    failedRecently: number;
    oldestQueuedAt?: string; // date-time
    /**
     * Up to 100: being judged, queued, then failed
     */
    jobs: ApiTypes.JudgeJobInfoDto[];
  }
  export interface JudgeRuntimeDto {
    /**
     * SHA-256 of the judge program's source files
     */
    judgeProgram: string;
    /**
     * The sandbox image (rootfs) ID, which identifies its compilers and interpreters
     */
    sandboxImage: string;
    /**
     * The Node.js version
     */
    node: string;
    os: string;
    kernel: string;
    arch: string;
    cpu: string;
  }
  export interface ListJudgeClientsResponseDto {
    judgeClients: ApiTypes.JudgeClientInfoDto[];
    hasManagePermission: boolean;
  }
  export interface ListRegistrationReviewsRequestDto {
    status?: "pending" | "approved" | "rejected";
    skipCount?: number;
    takeCount?: number;
  }
  export interface ListRegistrationReviewsResponseDto {
    error?: "PERMISSION_DENIED" | "NO_SUCH_APPLICATION" | "ALREADY_REVIEWED" | "DUPLICATE_USERNAME" | "DUPLICATE_EMAIL";
    reviews?: ApiTypes.RegistrationReviewDto[];
    count?: number;
  }
  export interface ListUserSessionsRequestDto {
    userId?: number;
    username?: string;
  }
  export interface ListUserSessionsResponseDto {
    error?: "PERMISSION_DENIED";
    sessions?: ApiTypes.UserSessionDto[];
    /**
     * Only available when querying the current user
     */
    currentSessionId?: number;
  }
  export interface LlmConfigurationDto {
    responsesRecovery?: "auto" | "off" | "background";
    type: "chat" | "responses" | "anthropic";
    baseUrl: string;
    apiKey?: string;
    model: string;
    reasoning?: string;
    maxTokens?: number;
  }
  export interface LocalizedProblemTagDto {
    id: number;
    name: string;
    color: string;
    nameLocale: "en_US" | "zh_CN";
  }
  export interface LoginRequestDto {
    /**
     * A SYZOJ 2 username is allowed to check if a user is not migrated.
     */
    username?: string;
    email?: string; // email
    password: string;
  }
  export interface LoginResponseDto {
    error?:
      | "REGISTRATION_PENDING"
      | "REGISTRATION_REJECTED"
      | "ALREADY_LOGGEDIN"
      | "NO_SUCH_USER"
      | "WRONG_PASSWORD"
      | "USER_NOT_MIGRATED";
    token?: string;
    username?: string;
    twoFactorChallenge?: ApiTypes.TwoFactorChallengeDto;
  }
  export interface MigrateUserRequestDto {
    email?: string; // email
    oldUsername?: string;
    oldPassword: string;
    newUsername?: string;
    newPassword: string;
  }
  export interface MigrateUserResponseDto {
    error?: "ALREADY_LOGGEDIN" | "NO_SUCH_USER" | "WRONG_PASSWORD" | "ALREADY_MIGRATED" | "DUPLICATE_USERNAME";
    token?: string;
  }
  export interface MoveSessionToCookieResponseDto {
    token?: string;
  }
  namespace Parameters {
    export type ContestId = number;
    export type Email = string; // email
    export type GroupId = string;
    export type Hacker = string;
    export type HackerId = number;
    export type Id = number;
    export type InputData = string;
    export type Jsonp = string;
    export type Locale = "en_US" | "zh_CN";
    export type MaintainceKey = string;
    export type Mine = string;
    export type Page = number;
    export type ProblemId = number;
    export type Query = string;
    export type ReferenceSubmissionId = number;
    export type StandardCode = string;
    export interface StandardCompileAndRunOptions {
      [name: string]: string;
    }
    export interface StandardFileIo {
      inputFilename: string;
      outputFilename: string;
    }
    export type StandardLanguage = string;
    export type Status = string;
    export type SubmissionId = number;
    export type Token = string;
    export type Username = string;
    export type ValidatorCode = string;
    export type ValidatorLanguage = string;
    export type Wildcard = "Start" | "End" | "Both";
    export type XCaptchaResult = string;
    export type XProofOfWork = string;
  }
  export interface PasskeyAssertionDto {
    id: string;
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
  }
  export interface PasskeyInfoDto {
    id: number;
    name: string;
    /**
     * The site domain the passkey works on.
     */
    rpId: string;
    createdAt: string; // date-time
    lastUsedAt?: string; // date-time
  }
  export interface PasskeyRegistrationDto {
    id: string;
    clientDataJSON: string;
    attestationObject: string;
    transports?: string[];
  }
  export interface PreferenceConfig {
    siteName: string;
    copyrightNotice: string;
    security: ApiTypes.PreferenceConfigSecurity;
    pagination: ApiTypes.PreferenceConfigPagination;
    misc: ApiTypes.PreferenceConfigMisc;
  }
  export interface PreferenceConfigMisc {
    appLogo: string;
    appLogoForTheme: {};
    googleAnalyticsId: string;
    plausibleApiEndpoint: string;
    gravatarCdn: string;
    redirectLegacyUrls: boolean;
    legacyContestsEntryUrl: boolean;
    homepageUserListOnMainView: boolean;
    sortUserByRating: boolean;
    renderMarkdownInUserBio: boolean;
    discussionReactionEmojis: string[];
    discussionReactionAllowCustomEmojis: boolean;
  }
  export interface PreferenceConfigPagination {
    homepageUserList: number;
    homepageProblemList: number;
    problemSet: number;
    searchProblemsPreview: number;
    submissions: number;
    submissionStatistics: number;
    userList: number;
    userAuditLogs: number;
    discussions: number;
    searchDiscussionsPreview: number;
    discussionReplies: number;
    discussionRepliesHead: number;
    discussionRepliesMore: number;
  }
  export interface PreferenceConfigSecurity {
    registrationMode?: "open" | "approval" | "closed";
    captchaEnabled: boolean;
    turnstileSiteKey?: string;
    requireEmailVerification: boolean;
    allowUserChangeUsername: boolean;
    allowEveryoneCreateProblem: boolean;
    allowNonPrivilegedUserEditPublicProblem: boolean;
    allowOwnerManageProblemPermission: boolean;
    allowOwnerDeleteProblem: boolean;
    discussionDefaultPublic: boolean;
    discussionReplyDefaultPublic: boolean;
    allowEveryoneCreateDiscussion: boolean;
  }
  export interface PrepareSubmissionFileUploadRequestDto {
    problemId: number;
    content: {};
    fileSize: number;
  }
  export interface ProblemContentSectionDto {
    sectionTitle: string;
    type: "Text" | "Sample";
    sampleId?: number;
    text?: string;
  }
  export interface ProblemFileDownloadInfoDto {
    filename: string;
    downloadUrl: string;
  }
  export interface ProblemFileDto {
    uuid: string;
    filename: string;
    size?: number;
    sha256?: string;
  }
  export interface ProblemGroupPermissionDto {
    group: ApiTypes.GroupMetaDto;
    permissionLevel: 1 | 2;
  }
  export interface ProblemLastSubmissionDto {
    lastSubmission?: ApiTypes.SubmissionBasicMetaDto;
    lastSubmissionContent?: {};
    lastAcceptedSubmission?: ApiTypes.SubmissionBasicMetaDto;
  }
  export interface ProblemLocalizedContentDto {
    locale: "en_US" | "zh_CN";
    title: string;
    contentSections: ApiTypes.ProblemContentSectionDto[];
  }
  export interface ProblemMetaDto {
    id: number;
    displayId?: number;
    type: "Traditional" | "Interaction" | "SubmitAnswer" | "Communication";
    isPublic: boolean;
    publicTime: string; // date-time
    ownerId: number;
    locales: ("en_US" | "zh_CN")[];
    difficulty: number | null;
    originalProblem: string;
    originalProblemTitle?: string;
    originalProblemLabel?: string;
    submissionCount?: number;
    acceptedSubmissionCount?: number;
  }
  export interface ProblemPermissionsDto {
    userPermissions: ApiTypes.ProblemUserPermissionDto[];
    groupPermissions: ApiTypes.ProblemGroupPermissionDto[];
  }
  export interface ProblemSampleDataMemberDto {
    inputData: string;
    outputData: string;
  }
  export interface ProblemStatementDto {
    difficulty?: number | null;
    originalProblem?: string;
    localizedContents: ApiTypes.ProblemLocalizedContentDto[];
    samples: ApiTypes.ProblemSampleDataMemberDto[];
    problemTagIds: number[];
  }
  export interface ProblemTagLocalizedNameDto {
    name: string;
    locale: "en_US" | "zh_CN";
  }
  export interface ProblemTagWithAllLocalesDto {
    id?: number;
    color?: string;
    localizedNames?: ApiTypes.ProblemTagLocalizedNameDto[];
  }
  export interface ProblemUserPermissionDto {
    user: ApiTypes.UserMetaDto;
    permissionLevel: 1 | 2;
  }
  export interface QueryAuditLogsRequestDto {
    userId?: number;
    username?: string;
    /**
     * The query string for action field, will be matching as prefix.
     */
    actionQuery?: string;
    ip?: string;
    firstObjectId?: number;
    secondObjectId?: number;
    locale: "en_US" | "zh_CN";
    skipCount: number;
    takeCount: number;
  }
  export interface QueryAuditLogsResponseDto {
    error?: "NO_SUCH_USER" | "PERMISSION_DENIED" | "TAKE_TOO_MANY";
    results?: ApiTypes.QueryAuditLogsResponseItemDto[];
    count?: number;
  }
  export interface QueryAuditLogsResponseItemDto {
    user: ApiTypes.UserMetaDto;
    ip: string;
    ipLocation: string;
    time: string; // date-time
    action: string;
    firstObjectType?: "User" | "Group" | "Problem" | "ProblemTag" | "Submission" | "Discussion" | "DiscussionReply";
    firstObjectId?: number;
    firstObject?: {};
    secondObjectType?: "User" | "Group" | "Problem" | "ProblemTag" | "Submission" | "Discussion" | "DiscussionReply";
    secondObjectId?: number;
    secondObject?: {};
    details?: {};
  }
  export interface QueryDiscussionsRequestDto {
    type?: "Discussion" | "Solution";
    locale: "en_US" | "zh_CN";
    keyword?: string;
    /**
     * `null` for global. `-1` for all problems. `-2` for global and problem discussions.
     */
    problemId?: number;
    publisherId?: number;
    nonpublic?: boolean;
    /**
     * Pass true to return discussion title only. For a preview in search bar.
     */
    titleOnly?: boolean;
    skipCount: number;
    takeCount: number;
  }
  export interface QueryDiscussionsResponseDiscussionDto {
    meta: ApiTypes.DiscussionMetaDto;
    problem?: ApiTypes.QueryDiscussionsResponseProblemDto;
    publisher: ApiTypes.UserMetaDto;
  }
  export interface QueryDiscussionsResponseDto {
    error?: "TAKE_TOO_MANY" | "NO_SUCH_PROBLEM" | "NO_SUCH_USER" | "PERMISSION_DENIED";
    discussions?: ApiTypes.QueryDiscussionsResponseDiscussionDto[];
    permissions?: ApiTypes.QueryDiscussionsResponsePermissionDto;
    count?: number;
    filterPublisher?: ApiTypes.UserMetaDto;
    filterProblem?: ApiTypes.QueryDiscussionsResponseProblemDto;
  }
  export interface QueryDiscussionsResponsePermissionDto {
    createDiscussion?: boolean;
    filterNonpublic?: boolean;
  }
  export interface QueryDiscussionsResponseProblemDto {
    meta: ApiTypes.ProblemMetaDto;
    title: string;
    titleLocale: "en_US" | "zh_CN";
  }
  export interface QueryParameters {
    mine?: ApiTypes.Parameters.Mine;
    id?: ApiTypes.Parameters.Id;
    problemId?: ApiTypes.Parameters.ProblemId;
    submissionId?: ApiTypes.Parameters.SubmissionId;
    contestId?: ApiTypes.Parameters.ContestId;
    hackerId?: ApiTypes.Parameters.HackerId;
    page?: ApiTypes.Parameters.Page;
    hacker?: ApiTypes.Parameters.Hacker;
    status?: ApiTypes.Parameters.Status;
    inputData?: ApiTypes.Parameters.InputData;
    referenceSubmissionId?: ApiTypes.Parameters.ReferenceSubmissionId;
    standardCode?: ApiTypes.Parameters.StandardCode;
    standardLanguage?: ApiTypes.Parameters.StandardLanguage;
    standardCompileAndRunOptions?: ApiTypes.Parameters.StandardCompileAndRunOptions;
    standardFileIo?: ApiTypes.Parameters.StandardFileIo;
    validatorCode?: ApiTypes.Parameters.ValidatorCode;
    validatorLanguage?: ApiTypes.Parameters.ValidatorLanguage;
  }
  export interface QueryProblemSetRequestDto {
    difficultyMin?: number;
    difficultyMax?: number;
    locale: "en_US" | "zh_CN";
    keyword?: string;
    /**
     * The result item by ID may NOT be included in the count.
     */
    keywordMatchesId?: boolean;
    tagIds?: number[];
    ownerId?: number;
    nonpublic?: boolean;
    /**
     * Pass true to return problem title only. For a preview in search bar.
     */
    titleOnly?: boolean;
    skipCount: number;
    takeCount: number;
  }
  export interface QueryProblemSetResponseDto {
    error?: "PERMISSION_DENIED" | "TAKE_TOO_MANY";
    result?: ApiTypes.QueryProblemSetResponseItemDto[];
    count?: number;
    filterTags?: ApiTypes.LocalizedProblemTagDto[];
    filterOwner?: ApiTypes.UserMetaDto;
    permissions?: ApiTypes.QueryProblemSetResponsePermissionDto;
  }
  export interface QueryProblemSetResponseItemDto {
    meta: ApiTypes.ProblemMetaDto;
    title: string;
    tags?: ApiTypes.LocalizedProblemTagDto[];
    resultLocale?: "en_US" | "zh_CN";
    submission?: ApiTypes.SubmissionBasicMetaDto;
  }
  export interface QueryProblemSetResponsePermissionDto {
    createProblem?: boolean;
    manageTags?: boolean;
    filterByOwner?: boolean;
    filterNonpublic?: boolean;
  }
  export interface QuerySubmissionRequestDto {
    locale: "en_US" | "zh_CN";
    problemId: number;
    problemDisplayId: number;
    submitter: string;
    codeLanguage: string;
    status:
      | "Pending"
      | "ConfigurationError"
      | "SystemError"
      | "Canceled"
      | "CompilationError"
      | "FileError"
      | "RuntimeError"
      | "TimeLimitExceeded"
      | "MemoryLimitExceeded"
      | "OutputLimitExceeded"
      | "PartiallyCorrect"
      | "WrongAnswer"
      | "Accepted"
      | "JudgementFailed"
      | "Fake"
      | "Hacked";
    minId: number;
    maxId: number;
    takeCount: number;
  }
  export interface QuerySubmissionResponseDto {
    error?: "NO_SUCH_PROBLEM" | "NO_SUCH_USER";
    submissions?: ApiTypes.SubmissionMetaDto[];
    hasSmallerId?: boolean;
    hasLargerId?: boolean;
    progressSubscriptionKey?: string;
  }
  export interface QuerySubmissionStatisticsRequestDto {
    locale: "en_US" | "zh_CN";
    problemId?: number;
    problemDisplayId?: number;
    statisticsType: "Fastest" | "MinMemory" | "MinAnswerSize" | "Earliest";
    skipCount: number;
    takeCount: number;
  }
  export interface QuerySubmissionStatisticsResponseDto {
    error?: "NO_SUCH_PROBLEM" | "PERMISSION_DENIED" | "TAKE_TOO_MANY";
    submissions?: ApiTypes.SubmissionMetaDto[];
    count?: number;
    scores?: number[];
  }
  export interface QueryUserMigrationInfoRequestDto {
    email?: string; // email
    oldUsername?: string;
  }
  export interface QueryUserMigrationInfoResponseDto {
    error?: "ALREADY_LOGGEDIN" | "NO_SUCH_USER";
    migrated?: boolean;
    usernameMustChange?: boolean;
  }
  export interface ReauthenticateRequestDto {
    totpCode?: string;
    recoveryCode?: string;
    passkey?: ApiTypes.PasskeyAssertionDto;
    password: string;
    /**
     * The challenge from getReauthenticationOptions, with 2FA.
     */
    challenge?: string;
  }
  export interface RecoveryCodesResponseDto {
    error?:
      | "PERMISSION_DENIED"
      | "NO_SUCH_USER"
      | "ALREADY_LOGGEDIN"
      | "REAUTHENTICATION_REQUIRED"
      | "WRONG_PASSWORD"
      | "REGISTRATION_PENDING"
      | "REGISTRATION_REJECTED"
      | "ALREADY_ENABLED"
      | "NOT_ENABLED"
      | "SETUP_EXPIRED"
      | "INVALID_CODE"
      | "INVALID_PASSKEY"
      | "PASSKEY_UNAVAILABLE"
      | "TOO_MANY_PASSKEYS"
      | "NO_SUCH_PASSKEY"
      | "CHALLENGE_EXPIRED"
      | "TOO_MANY_ATTEMPTS";
    /**
     * Shown once: only hashes are stored.
     */
    recoveryCodes?: string[];
  }
  export interface RegisterRequestDto {
    username: string;
    email: string; // email
    emailVerificationCode?: string;
    password: string;
  }
  export interface RegisterResponseDto {
    error?:
      | "REGISTRATION_CLOSED"
      | "ALREADY_LOGGEDIN"
      | "DUPLICATE_USERNAME"
      | "DUPLICATE_EMAIL"
      | "INVALID_EMAIL_VERIFICATION_CODE";
    registrationStatus?: "pending" | "approved";
    token?: string;
  }
  export interface RegistrationReviewDto {
    applicationId: number;
    userId: number | null;
    username: string;
    email: string;
    registrationTime: string; // date-time
    status: "pending" | "approved" | "rejected";
    reviewedAt: string | null; // date-time
    reviewedBy: number | null;
    reason: string | null;
  }
  export interface RejudgeSubmissionRequestDto {
    submissionId: number;
  }
  export interface RejudgeSubmissionResponseDto {
    error?: "NO_SUCH_SUBMISSION" | "PERMISSION_DENIED";
  }
  export interface RemovePasskeyRequestDto {
    id: number;
  }
  export interface RemoveProblemFilesRequestDto {
    problemId: number;
    type: "TestData" | "AdditionalFile";
    filenames: string[];
  }
  export interface RemoveProblemFilesResponseDto {
    error?: "NO_SUCH_PROBLEM" | "PERMISSION_DENIED";
  }
  export interface RemoveUserFromGroupRequestDto {
    userId: number;
    groupId: number;
  }
  export interface RemoveUserFromGroupResponseDto {
    error?:
      "PERMISSION_DENIED" | "NO_SUCH_USER" | "NO_SUCH_GROUP" | "USER_NOT_IN_GROUP" | "GROUP_ADMIN_CAN_NOT_BE_REMOVED";
  }
  export interface RemovedTestDataFileDto {
    /**
     * From a data version that uses it; null if none does
     */
    problemId?: number;
    problemDisplayId?: number;
    filename?: string;
    /**
     * null once the file is gone
     */
    size?: number;
    removedAt: string; // date-time
    /**
     * The numbers of the data versions that use it
     */
    versions: number[];
    /**
     * What the next cleanup does: deletes it, keeps it, or releases it (a problem uses it again)
     */
    action: "Delete" | "Keep" | "Release";
    /**
     * While kept: when its last reason ends; absent while one has no end
     */
    keptUntil?: string; // date-time
    reasons: ApiTypes.TestDataRetentionReasonDto[];
  }
  export interface RenameGroupRequestDto {
    groupId: number;
    name: string;
  }
  export interface RenameGroupResponseDto {
    error?: "PERMISSION_DENIED" | "NO_SUCH_GROUP" | "DUPLICATE_GROUP_NAME";
  }
  export interface RenameProblemFileRequestDto {
    problemId: number;
    type: "TestData" | "AdditionalFile";
    filename: string;
    newFilename: string;
  }
  export interface RenameProblemFileResponseDto {
    error?: "NO_SUCH_PROBLEM" | "PERMISSION_DENIED" | "NO_SUCH_FILE" | "FILE_ALREADY_EXISTS";
  }
  export type RequestBody = ApiTypes.SelfEvalRequestDto;
  export interface ResetJudgeClientKeyRequestDto {
    id: number;
  }
  export interface ResetJudgeClientKeyResponseDto {
    error?: "PERMISSION_DENIED" | "NO_SUCH_JUDGE_CLIENT" | "REAUTHENTICATION_REQUIRED";
    key?: string;
  }
  export interface ResetPasswordRequestDto {
    email: string; // email
    emailVerificationCode?: string;
    newPassword: string;
  }
  export interface ResetPasswordResponseDto {
    error?:
      | "REGISTRATION_PENDING"
      | "REGISTRATION_REJECTED"
      | "ALREADY_LOGGEDIN"
      | "NO_SUCH_USER"
      | "INVALID_EMAIL_VERIFICATION_CODE";
    token?: string;
    twoFactorChallenge?: ApiTypes.TwoFactorChallengeDto;
  }
  export interface ResetUserTwoFactorRequestDto {
    userId: number;
  }
  namespace Responses {
    export interface $200 {}
    export interface $201 {}
    export interface $403 {}
  }
  export interface ReviewRegistrationRequestDto {
    applicationId: number;
    decision: "approved" | "rejected";
    reason?: string;
  }
  export interface ReviewRegistrationResponseDto {
    error?: "PERMISSION_DENIED" | "NO_SUCH_APPLICATION" | "ALREADY_REVIEWED" | "DUPLICATE_USERNAME" | "DUPLICATE_EMAIL";
    review?: ApiTypes.RegistrationReviewDto;
  }
  export interface RevokeUserSessionRequestDto {
    userId: number;
    /**
     * Falsy to revoke ALL sessions of the user (except the current session, if the user is current user)
     */
    sessionId?: number;
  }
  export interface RevokeUserSessionResponseDto {
    error?: "PERMISSION_DENIED" | "NO_SUCH_USER";
  }
  export interface SaveAiConfigurationDto {
    llm: ApiTypes.LlmConfigurationDto;
    search: ApiTypes.SearchConfigurationDto;
    autoOnSave: boolean;
    maxConcurrentJobs?: number;
    clearLlmKey?: boolean;
    clearSearchKey?: boolean;
  }
  export interface SaveDto {}
  export interface SearchConfigurationDto {
    type: "tavily" | "mcp";
    baseUrl: string;
    apiKey?: string;
    tool?: string;
  }
  export interface SearchGroupResponseDto {
    groupMetas: ApiTypes.GroupMetaDto[];
  }
  export interface SearchUserResponseDto {
    userMetas: ApiTypes.UserMetaDto[];
  }
  export interface SelfEvalRequestDto {
    id?: number;
    problemId?: number;
    contestId?: number;
    submissionId?: number;
    page?: number;
    content?: {
      language: string;
      code: string;
      compileAndRunOptions: {};
    };
    generatorCode?: string;
    standardCode?: string;
    subtaskIds?: number[];
    attestSameGenerator?: boolean;
    standardFileIo?: {
      inputFilename: string;
      outputFilename: string;
    };
  }
  export interface SendEmailVerificationCodeRequestDto {
    email: string; // email
    type: "Register" | "ChangeEmail" | "ResetPassword";
    locale: "en_US" | "zh_CN";
  }
  export interface SendEmailVerificationCodeResponseDto {
    error?:
      | "REGISTRATION_PENDING"
      | "REGISTRATION_REJECTED"
      | "REGISTRATION_CLOSED"
      | "PERMISSION_DENIED"
      | "DUPLICATE_EMAIL"
      | "NO_SUCH_USER"
      | "ALREADY_LOGGEDIN"
      | "FAILED_TO_SEND"
      | "RATE_LIMITED";
    errorMessage?: string;
  }
  export interface ServerVersionDto {
    hash: string;
    date: string;
  }
  export interface SetDiscussionPermissionsRequestDto {
    discussionId: number;
    userPermissions: ApiTypes.SetDiscussionPermissionsRequestUserPermissionDto[];
    groupPermissions: ApiTypes.SetDiscussionPermissionsRequestGroupPermissionDto[];
  }
  export interface SetDiscussionPermissionsRequestGroupPermissionDto {
    groupId: number;
    permissionLevel: 1 | 2;
  }
  export interface SetDiscussionPermissionsRequestUserPermissionDto {
    userId: number;
    permissionLevel: 1 | 2;
  }
  export interface SetDiscussionPermissionsResponseDto {
    error?: "PERMISSION_DENIED" | "NO_SUCH_DISCUSSION" | "NO_SUCH_USER" | "NO_SUCH_GROUP";
    errorObjectId?: number;
  }
  export interface SetDiscussionPublicRequestDto {
    discussionId: number;
    isPublic: boolean;
  }
  export interface SetDiscussionPublicResponseDto {
    error?: "PERMISSION_DENIED" | "NO_SUCH_DISCUSSION";
  }
  export interface SetDiscussionReplyPublicRequestDto {
    discussionReplyId: number;
    isPublic: boolean;
  }
  export interface SetDiscussionReplyPublicResponseDto {
    error?: "PERMISSION_DENIED" | "NO_SUCH_DISCUSSION_REPLY";
  }
  export interface SetGroupAdminRequestDto {
    userId: number;
    groupId: number;
    isGroupAdmin: boolean;
  }
  export interface SetGroupAdminResponseDto {
    error?: "PERMISSION_DENIED" | "NO_SUCH_USER" | "NO_SUCH_GROUP" | "USER_NOT_IN_GROUP";
  }
  export interface SetJudgeClientDrainingRequestDto {
    id: number;
    /**
     * true: send it no new tasks; false: resume
     */
    draining: boolean;
  }
  export interface SetJudgeClientDrainingResponseDto {
    error?: "PERMISSION_DENIED" | "NO_SUCH_JUDGE_CLIENT";
  }
  export interface SetPermissionsDto {}
  export interface SetProblemDisplayIdRequestDto {
    problemId: number;
    displayId: number;
  }
  export interface SetProblemDisplayIdResponseDto {
    error?: "PERMISSION_DENIED" | "NO_SUCH_PROBLEM" | "DUPLICATE_DISPLAY_ID" | "PUBLIC_PROBLEM_MUST_HAVE_DISPLAY_ID";
  }
  export interface SetProblemPermissionsRequestDto {
    problemId: number;
    userPermissions: ApiTypes.SetProblemPermissionsRequestUserPermissionDto[];
    groupPermissions: ApiTypes.SetProblemPermissionsRequestGroupPermissionDto[];
  }
  export interface SetProblemPermissionsRequestGroupPermissionDto {
    groupId: number;
    permissionLevel: 1 | 2;
  }
  export interface SetProblemPermissionsRequestUserPermissionDto {
    userId: number;
    permissionLevel: 1 | 2;
  }
  export interface SetProblemPermissionsResponseDto {
    error?: "PERMISSION_DENIED" | "NO_SUCH_PROBLEM" | "NO_SUCH_USER" | "NO_SUCH_GROUP";
    errorObjectId?: number;
  }
  export interface SetProblemPublicRequestDto {
    problemId: number;
    isPublic: boolean;
  }
  export interface SetProblemPublicResponseDto {
    error?: "PERMISSION_DENIED" | "NO_SUCH_PROBLEM" | "NO_DISPLAY_ID";
  }
  export interface SetSubmissionPublicRequestDto {
    submissionId: number;
    isPublic: boolean;
  }
  export interface SetSubmissionPublicResponseDto {
    error?: "NO_SUCH_SUBMISSION" | "PERMISSION_DENIED";
  }
  export interface SetTestDataKeptRequestDto {
    problemId: number;
    /**
     * The problem's data version number
     */
    version: number;
    /**
     * true keeps its test data until released; false lets the retention policy decide
     */
    keep: boolean;
  }
  export interface SetTestDataKeptResponseDto {
    error?: "NO_SUCH_PROBLEM" | "PERMISSION_DENIED" | "NO_SUCH_DATA_VERSION" | "TEST_DATA_DELETED";
    testData?: ApiTypes.TestDataAvailabilityDto;
  }
  export interface SetUserPrivilegesRequestDto {
    userId: number;
    privileges: (
      | "EditHomepage"
      | "ManageUser"
      | "ManageUserGroup"
      | "ManageProblem"
      | "ManageContest"
      | "ManageDiscussion"
      | "ViewSite"
      | "ViewUsers"
      | "EditOwnProfile"
      | "ViewPrivateUserInfo"
      | "CreateGroup"
      | "ViewProblem"
      | "ViewHiddenProblem"
      | "CreateProblem"
      | "EditOwnProblem"
      | "EditAnyProblem"
      | "DeleteOwnProblem"
      | "DeleteAnyProblem"
      | "ManageProblemPermissions"
      | "ManageProblemVisibility"
      | "ManageProblemTags"
      | "ReadProblemData"
      | "EditProblemData"
      | "DownloadProblemAttachments"
      | "SubmitProblem"
      | "ViewSubmission"
      | "ReadAnySubmissionCode"
      | "ReadCodeAfterAccepted"
      | "RejudgeSubmission"
      | "DeleteSubmission"
      | "ViewDiscussion"
      | "CreateDiscussion"
      | "EditOwnDiscussion"
      | "EditAnyDiscussion"
      | "DeleteOwnDiscussion"
      | "DeleteAnyDiscussion"
      | "ReplyDiscussion"
      | "ReactDiscussion"
      | "EditOwnReply"
      | "ManageDiscussionReplies"
      | "ViewContest"
      | "ViewHiddenContest"
      | "CreateContest"
      | "EditContest"
      | "ParticipateContest"
      | "ViewContestScoreboard"
      | "ViewHiddenContestScoreboard"
      | "ExportContest"
      | "ManageSummaries"
      | "ManageStudyLists"
      | "ManageAiConfiguration"
      | "UseAi"
      | "GenerateTestdata"
      | "ImportProblem"
      | "ManagePermissions"
      | "SkipRecaptcha"
      | "ManageRegistrationReviews"
      | "ViewTeam"
      | "CreateTeam"
      | "ManageTeams"
      | "FakeSubmission"
      | "ViewHack"
      | "CreateHack"
      | "ManageHack"
      | "CreateSelfEval"
    )[];
  }
  export interface SetUserPrivilegesResponseDto {
    error?: "PERMISSION_DENIED" | "NO_SUCH_USER" | "FAILED" | "REAUTHENTICATION_REQUIRED";
  }
  export interface SignedFileUploadRequestDto {
    uuid: string;
    method: "POST" | "PUT";
    url: string;
    extraFormData?: {};
    fileFieldName?: string;
  }
  export interface SiteManagementSettingsDto {
    registrationMode: "open" | "approval" | "closed";
    configuredRegistrationMode: "open" | "approval" | "closed";
    usesOverride: boolean;
  }
  export interface StartAiJobDto {
    problemId?: number;
    action: "metadata" | "tags" | "source" | "difficulty" | "translate" | "tutorial" | "testdata" | "all" | "import";
    attachmentToken?: string;
    count?: number;
    markdown?: string;
    image?: string;
    automatic?: boolean;
    problemType?: "Traditional" | "Interaction" | "Communication";
    communicationMode?: "run-twice" | "grader";
  }
  export interface StudyListIdDto {}
  export interface SubmissionBasicMetaDto {
    id: number;
    isPublic: boolean;
    codeLanguage: string;
    answerSize: number;
    score: number;
    status:
      | "Pending"
      | "ConfigurationError"
      | "SystemError"
      | "Canceled"
      | "CompilationError"
      | "FileError"
      | "RuntimeError"
      | "TimeLimitExceeded"
      | "MemoryLimitExceeded"
      | "OutputLimitExceeded"
      | "PartiallyCorrect"
      | "WrongAnswer"
      | "Accepted"
      | "JudgementFailed"
      | "Fake"
      | "Hacked";
    submitTime: string; // date-time
    timeUsed: number;
    memoryUsed: number;
  }
  export interface SubmissionDataVersionDto {
    /**
     * The problem's data version number the submission is (being) judged with
     */
    version: number;
    /**
     * Whether the problem's test data and judge settings are still that version
     */
    current: boolean;
    /**
     * Whether its test data is all still there
     */
    testData: {
      /**
       * InUse: the problem uses all of it; Retained: some was removed from the problem but is kept; Deleted: some is gone, so results judged with it can't be judged again with the same data
       */
      state: "InUse" | "Retained" | "Deleted";
      /**
       * Retained: when the first of its removed files may be deleted; absent while kept as long as needed
       */
      retainedUntil?: string; // date-time
      /**
       * Retained: the next cleanup, within ten minutes, deletes some of it
       */
      deletionDue?: boolean;
      /**
       * Retained: why
       */
      reasons?: (
        | "Grace"
        | "WaitingSubmission"
        | "WaitingHack"
        | "WaitingSelfEval"
        | "Contest"
        | "Result"
        | "EarlierResult"
        | "Kept"
      )[];
      /**
       * Who chose to keep it until released; absent if nobody did
       */
      keptBy?: string;
      keptAt?: string; // date-time
    };
  }
  export interface SubmissionEarlierResultDto {
    status:
      | "Pending"
      | "ConfigurationError"
      | "SystemError"
      | "Canceled"
      | "CompilationError"
      | "FileError"
      | "RuntimeError"
      | "TimeLimitExceeded"
      | "MemoryLimitExceeded"
      | "OutputLimitExceeded"
      | "PartiallyCorrect"
      | "WrongAnswer"
      | "Accepted"
      | "JudgementFailed"
      | "Fake"
      | "Hacked";
    score?: number;
    timeUsed?: number;
    memoryUsed?: number;
    /**
     * The data version it was judged with; null if not recorded
     */
    dataVersion?: number;
    /**
     * Whether that data version's test data is all still there; absent if not recorded
     */
    testData?: {
      /**
       * InUse: the problem uses all of it; Retained: some was removed from the problem but is kept; Deleted: some is gone, so results judged with it can't be judged again with the same data
       */
      state: "InUse" | "Retained" | "Deleted";
      /**
       * Retained: when the first of its removed files may be deleted; absent while kept as long as needed
       */
      retainedUntil?: string; // date-time
      /**
       * Retained: the next cleanup, within ten minutes, deletes some of it
       */
      deletionDue?: boolean;
      /**
       * Retained: why
       */
      reasons?: (
        | "Grace"
        | "WaitingSubmission"
        | "WaitingHack"
        | "WaitingSelfEval"
        | "Contest"
        | "Result"
        | "EarlierResult"
        | "Kept"
      )[];
      /**
       * Who chose to keep it until released; absent if nobody did
       */
      keptBy?: string;
      keptAt?: string; // date-time
    };
    /**
     * What it was judged with; null if not recorded
     */
    judgeRuntime?: {
      /**
       * SHA-256 of the judge program's source files
       */
      judgeProgram: string;
      /**
       * The sandbox image (rootfs) ID, which identifies its compilers and interpreters
       */
      sandboxImage: string;
      /**
       * The Node.js version
       */
      node: string;
      os: string;
      kernel: string;
      arch: string;
      cpu: string;
      /**
       * The judge machine's name now; null if it was deleted
       */
      judgeMachine?: string;
    };
    /**
     * When a rejudge replaced it
     */
    replacedAt: string; // date-time
  }
  export interface SubmissionJudgeRuntimeDto {
    /**
     * SHA-256 of the judge program's source files
     */
    judgeProgram: string;
    /**
     * The sandbox image (rootfs) ID, which identifies its compilers and interpreters
     */
    sandboxImage: string;
    /**
     * The Node.js version
     */
    node: string;
    os: string;
    kernel: string;
    arch: string;
    cpu: string;
    /**
     * The judge machine's name now; null if it was deleted
     */
    judgeMachine?: string;
  }
  export interface SubmissionMetaDto {
    id: number;
    isPublic: boolean;
    codeLanguage: string;
    answerSize: number;
    score: number;
    status:
      | "Pending"
      | "ConfigurationError"
      | "SystemError"
      | "Canceled"
      | "CompilationError"
      | "FileError"
      | "RuntimeError"
      | "TimeLimitExceeded"
      | "MemoryLimitExceeded"
      | "OutputLimitExceeded"
      | "PartiallyCorrect"
      | "WrongAnswer"
      | "Accepted"
      | "JudgementFailed"
      | "Fake"
      | "Hacked";
    submitTime: string; // date-time
    timeUsed: number;
    memoryUsed: number;
    problem: ApiTypes.ProblemMetaDto;
    problemTitle: string;
    submitter: ApiTypes.UserMetaDto;
    progressType?: "Preparing" | "Compiling" | "Running" | "Finished";
  }
  export interface SubmitRequestDto {
    problemId: number;
    content: {};
    uploadInfo?: ApiTypes.FileUploadInfoDto;
  }
  export interface SubmitResponseDto {
    error?: "PERMISSION_DENIED" | "NO_SUCH_PROBLEM" | "FILE_TOO_LARGE" | "FILE_UUID_EXISTS" | "FILE_NOT_UPLOADED";
    submissionId?: number;
    signedUploadRequest?: ApiTypes.SignedFileUploadRequestDto;
  }
  export interface TeamAssignmentItemDto {
    problemId: number;
    section: string;
    note: string;
  }
  export interface TeamRequestDto {
    teamId?: number;
    id?: number;
    name?: string;
    description?: string;
    announcement?: string;
    joinPolicy?: "open" | "approval" | "closed";
    groupChangeLocked?: boolean;
    archived?: boolean;
    message?: string;
    userId?: number;
    userIds?: number[];
    action?: "approve" | "reject" | "remove" | "block" | "unblock" | "setGroup" | "note" | "permissions";
    groupId?: number | null;
    note?: string;
    permissions?: ("settings" | "members" | "problems" | "contests" | "assignments" | "discussions" | "files")[];
    sourceProblemId?: number;
    title?: string;
    subtitle?: string;
    rule?: "noi" | "ioi" | "acm" | "strictioi";
    startTime?: string;
    endTime?: string;
    languages?: string[];
    visibility?: "private" | "public" | "invite";
    invitedUserIds?: number[];
    contestId?: number;
    problemId?: number;
    content?: string;
    kind?: "problem" | "contest" | "discussion" | "assignment";
    resourceId?: number;
    items?: ApiTypes.TeamAssignmentItemDto[];
    deadline?: string | null;
    assignedUserIds?: number[];
    assignedGroupIds?: number[];
    size?: number;
    uuid?: string; // uuid
    part?: number;
    uploadInfo?: ApiTypes.FileUploadInfoDto;
    token?: string; // uuid
    maxUses?: number;
    expiresAt?: string;
  }
  export interface TestDataAvailabilityDto {
    /**
     * InUse: the problem uses all of it; Retained: some was removed from the problem but is kept; Deleted: some is gone, so results judged with it can't be judged again with the same data
     */
    state: "InUse" | "Retained" | "Deleted";
    /**
     * Retained: when the first of its removed files may be deleted; absent while kept as long as needed
     */
    retainedUntil?: string; // date-time
    /**
     * Retained: the next cleanup, within ten minutes, deletes some of it
     */
    deletionDue?: boolean;
    /**
     * Retained: why
     */
    reasons?: (
      | "Grace"
      | "WaitingSubmission"
      | "WaitingHack"
      | "WaitingSelfEval"
      | "Contest"
      | "Result"
      | "EarlierResult"
      | "Kept"
    )[];
    /**
     * Who chose to keep it until released; absent if nobody did
     */
    keptBy?: string;
    keptAt?: string; // date-time
  }
  export interface TestDataRetentionPolicyDto {
    /**
     * Days after a contest ends that the test data its submissions were judged with stays.
     */
    contestDays: number;
    /**
     * Days that removed test data stays for the results judged with it, from its removal (or from the rejudge that replaced a result judged with it).
     */
    resultDays: number;
  }
  export interface TestDataRetentionReasonDto {
    kind:
      | "Grace"
      | "WaitingSubmission"
      | "WaitingHack"
      | "WaitingSelfEval"
      | "Contest"
      | "Result"
      | "EarlierResult"
      | "Kept";
    /**
     * When it ends; absent for as long as its cause lasts
     */
    until?: string; // date-time
    /**
     * The number of the data version it comes from
     */
    version?: number;
    contestId?: number;
    contestTitle?: string;
    /**
     * Who kept the data version
     */
    keptBy?: string;
  }
  export interface TestDataRetentionReasonTotalsDto {
    files: number;
    bytes: number;
    kind:
      | "Grace"
      | "WaitingSubmission"
      | "WaitingHack"
      | "WaitingSelfEval"
      | "Contest"
      | "Result"
      | "EarlierResult"
      | "Kept";
  }
  export interface TestDataRetentionReportDto {
    policy: ApiTypes.TestDataRetentionPolicyDto;
    /**
     * Test data removed from problems that still exists
     */
    removed: {
      files: number;
      bytes: number;
    };
    /**
     * Removed files the next cleanup keeps
     */
    kept: {
      files: number;
      bytes: number;
    };
    /**
     * Removed files the next cleanup deletes
     */
    deletedAtNextCleanup: {
      files: number;
      bytes: number;
    };
    /**
     * A file counts for each reason
     */
    byReason: ApiTypes.TestDataRetentionReasonTotalsDto[];
    /**
     * Those the next cleanup deletes first, then the largest it keeps
     */
    files: ApiTypes.RemovedTestDataFileDto[];
    /**
     * How many removed files there are, including any not looked at
     */
    total: number;
    /**
     * How often the cleanup runs
     */
    cleanupMinutes: number;
  }
  export interface TestDataRetentionTotalsDto {
    files: number;
    bytes: number;
  }
  export interface ToggleReactionRequestDto {
    type: "Discussion" | "DiscussionReply";
    id: number;
    emoji: string;
    reaction: boolean;
  }
  export interface ToggleReactionResponseDto {
    error?: "PERMISSION_DENIED" | "NO_SUCH_DISCUSSION" | "NO_SUCH_DISCUSSION_REPLY" | "INVALID_EMOJI";
  }
  export interface TwoFactorActionResponseDto {
    error?:
      | "PERMISSION_DENIED"
      | "NO_SUCH_USER"
      | "ALREADY_LOGGEDIN"
      | "REAUTHENTICATION_REQUIRED"
      | "WRONG_PASSWORD"
      | "REGISTRATION_PENDING"
      | "REGISTRATION_REJECTED"
      | "ALREADY_ENABLED"
      | "NOT_ENABLED"
      | "SETUP_EXPIRED"
      | "INVALID_CODE"
      | "INVALID_PASSKEY"
      | "PASSKEY_UNAVAILABLE"
      | "TOO_MANY_PASSKEYS"
      | "NO_SUCH_PASSKEY"
      | "CHALLENGE_EXPIRED"
      | "TOO_MANY_ATTEMPTS";
  }
  export interface TwoFactorChallengeDto {
    /**
     * Single-use, expires after 5 minutes.
     */
    token: string;
    methods: ("totp" | "passkey" | "recoveryCode")[];
    /**
     * PublicKeyCredentialRequestOptions with base64url binary fields.
     */
    passkey?: {
      [name: string]: any;
    };
  }
  export interface TwoFactorStatusDto {
    enabled: boolean;
    totp: boolean;
    totpEnabledAt?: string; // date-time
    recoveryCodesRemaining: number;
    passkeys: ApiTypes.PasskeyInfoDto[];
  }
  export interface UpdateDiscussionReplyRequestDto {
    discussionReplyId: number;
    content: string;
  }
  export interface UpdateDiscussionReplyResponseDto {
    error?: "PERMISSION_DENIED" | "NO_SUCH_DISCUSSION_REPLY";
    editTime?: string; // date-time
  }
  export interface UpdateDiscussionRequestDto {
    type?: "Discussion" | "Solution";
    problemId?: number | null;
    discussionId: number;
    title: string;
    content: string;
  }
  export interface UpdateDiscussionResponseDto {
    error?: "SOLUTION_REQUIRES_PROBLEM" | "NO_SUCH_PROBLEM" | "PERMISSION_DENIED" | "NO_SUCH_DISCUSSION";
  }
  export interface UpdateHomepageSettingsRequestDto {
    settings: ApiTypes.HomepageSettings;
  }
  export interface UpdateHomepageSettingsResponseDto {
    error?: "PERMISSION_DENIED" | "NO_SUCH_DISCUSSION";
    errorDiscussionId?: number;
  }
  export interface UpdateProblemJudgeInfoRequestDto {
    problemId: number;
    judgeInfo: {};
    submittable: boolean;
  }
  export interface UpdateProblemJudgeInfoResponseDto {
    error?: "NO_SUCH_PROBLEM" | "PERMISSION_DENIED" | "INVALID_JUDGE_INFO";
    judgeInfoError?: string[];
  }
  export interface UpdateProblemRequestUpdatingLocalizedContentDto {
    locale: "en_US" | "zh_CN";
    title: string;
    contentSections: ApiTypes.ProblemContentSectionDto[];
  }
  export interface UpdateProblemStatementRequestDto {
    difficulty?: number | null;
    originalProblem?: string;
    problemId: number;
    localizedContents: ApiTypes.UpdateProblemRequestUpdatingLocalizedContentDto[];
    samples: ApiTypes.ProblemSampleDataMemberDto[];
    problemTagIds: number[];
  }
  export interface UpdateProblemStatementResponseDto {
    error?: "PERMISSION_DENIED" | "NO_SUCH_PROBLEM" | "NO_SUCH_PROBLEM_TAG" | "FAILED";
  }
  export interface UpdateProblemTagRequestDto {
    id: number;
    localizedNames: ApiTypes.ProblemTagLocalizedNameDto[];
    color: string;
  }
  export interface UpdateProblemTagResponseDto {
    error?: "NO_SUCH_PROBLEM_TAG" | "PERMISSION_DENIED";
  }
  export interface UpdateRegistrationModeRequestDto {
    /**
     * Null restores the server YAML mode.
     */
    registrationMode: "open" | "approval" | "closed";
  }
  export interface UpdateUserPasswordRequestDto {
    userId: number;
    oldPassword?: string;
    password: string;
  }
  export interface UpdateUserPasswordResponseDto {
    error?: "PERMISSION_DENIED" | "NO_SUCH_USER" | "WRONG_OLD_PASSWORD" | "REAUTHENTICATION_REQUIRED";
  }
  export interface UpdateUserPreferenceRequestDto {
    userId: number;
    preference: ApiTypes.UserPreferenceDto;
  }
  export interface UpdateUserPreferenceResponseDto {
    error?: "NO_SUCH_USER" | "PERMISSION_DENIED";
  }
  export interface UpdateUserProfileRequestDto {
    userId: number;
    username?: string;
    email?: string; // email
    publicEmail: boolean;
    avatarInfo: string;
    nickname: string;
    bio: string;
    information: ApiTypes.UserInformationDto;
  }
  export interface UpdateUserProfileResponseDto {
    error?:
      "PERMISSION_DENIED" | "NO_SUCH_USER" | "DUPLICATE_USERNAME" | "DUPLICATE_EMAIL" | "REAUTHENTICATION_REQUIRED";
  }
  export interface UpdateUserSelfEmailRequestDto {
    email: string; // email
    emailVerificationCode?: string;
  }
  export interface UpdateUserSelfEmailResponseDto {
    error?: "PERMISSION_DENIED" | "DUPLICATE_EMAIL" | "INVALID_EMAIL_VERIFICATION_CODE" | "REAUTHENTICATION_REQUIRED";
  }
  export interface UserAvatarDto {
    type: "gravatar" | "github" | "qq";
    key: string;
  }
  export interface UserInformationDto {
    organization: string;
    location: string;
    url: string; // uri
    telegram: string;
    qq: string;
    github: string;
  }
  export interface UserMetaDto {
    id: number;
    username: string;
    email: string;
    nickname: string;
    bio: string;
    avatar: ApiTypes.UserAvatarDto;
    isAdmin: boolean;
    acceptedProblemCount: number;
    submissionCount: number;
    rating: number;
    registrationTime: string; // date-time
  }
  export interface UserPreferenceCodeDto {
    defaultLanguage?: string;
    defaultCompileAndRunOptions?: {
      [name: string]: string;
    };
  }
  export interface UserPreferenceCodeFormatterDto {
    disableByDefault?: boolean;
    options?: string;
  }
  export interface UserPreferenceDto {
    locale?: ApiTypes.UserPreferenceLocaleDto;
    theme?: string;
    font?: ApiTypes.UserPreferenceFontDto;
    codeFormatter?: ApiTypes.UserPreferenceCodeFormatterDto;
    code?: ApiTypes.UserPreferenceCodeDto;
  }
  export interface UserPreferenceFontDto {
    contentFontFace?: string;
    codeFontFace?: string;
    codeFontSize?: number;
    codeLineHeight?: number;
    codeFontLigatures?: boolean;
    markdownEditorFont?: "content" | "code";
  }
  export interface UserPreferenceLocaleDto {
    system?: "en_US" | "zh_CN";
    content?: "en_US" | "zh_CN";
    hideUnavailableMessage?: boolean;
  }
  export interface UserSessionDto {
    sessionId: number;
    loginIp: string;
    loginIpLocation: string;
    userAgent: string;
    loginTime: number;
    lastAccessTime: number;
  }
}
