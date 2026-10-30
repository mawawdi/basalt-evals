import type { StudioObservation } from "./index.js";

/** Each diagnostics channel keeps its first entries up to this limit; later ones are not kept. */
export const DIAGNOSTIC_CHANNEL_LIMIT = 100;

export const DIAGNOSTIC_SEMANTICS =
  "Diagnostics retain two potentially overlapping channels: messages from Output and scriptErrors from ScriptContext.Error. Do not add their counts or assume matching messages identify the same event. A script error retains its engine-supplied stackTrace and source path/class. source.inDataModel records place membership only at capture time, not ownership: false may describe a plugin or a candidate script that was unparented; true may describe a candidate, seed or harness script. Attribute errors using the path, stack and sealed source. Neither membership value alone proves or rules out a mechanic error. source.kind=unavailable means attribution is unknown, not clean or external. Do not infer candidate fault or a clean mechanic from an unattributed output message; abstain on a mechanic-scoped claim when its origin cannot be established.";

/** Output guarantees, checked against the evidence union and exercised by connector tests. */
const STUDIO_OBSERVATION_RESULTS = {
  binding_failure: {
    fields: ["requestedKind", "path", "reason"],
    meaning: "Invalid public binding, distinct from observed absence or a sampled false value.",
  },
  instance: {
    fields: ["exists", "className"],
    meaning:
      "Concrete class when present. Role resolution already enforces the declared class and scope.",
  },
  instance_name: {
    fields: ["exists", "name"],
    meaning: "Actual resolved instance name; a semantic tag alone does not establish the name.",
  },
  instance_value: {
    fields: ["exists", "className", "value"],
    meaning:
      "The Value of an IntValue, NumberValue, BoolValue or StringValue at collection time: a number, a boolean or a string. It reads no other class and no other property. exists=false means the instance is absent or has another class, without distinguishing which; the fallback false value must not pass a comparison.",
  },
  part_motion: {
    fields: ["samples", "delta"],
    meaning:
      "Samples contain actual elapsedMs and x/y/z. delta is maximum displacement from the first sample, not accumulated path length. No samples means unavailable motion.",
  },
  actor_part_motion: {
    fields: ["actor", "exists", "samples", "partDelta", "actorDelta", "maxRelativeDelta"],
    meaning:
      "Actor and part positions on one clock. Every sample contains elapsedMs, platform x/y/z, actorX/actorY/actorZ, localX/localY/localZ and sizeX/sizeY/sizeZ. This includes the platform trajectory as well as the actor trajectory; an additional part_motion trace is not required merely to obtain platform samples in the same window. Combined support and relative-motion evidence can assess carrying after controlled placement; setup alone cannot.",
  },
  actor_part_support: {
    fields: [
      "actor",
      "exists",
      "localX",
      "localY",
      "localZ",
      "sizeX",
      "sizeY",
      "sizeZ",
      "hitTarget",
      "hitDistance",
    ],
    meaning:
      "Actual geometry and a downward ray against the target. A miss cannot exclude another legitimate support arrangement.",
  },
  gui_text: {
    fields: ["exists", "text", "visible"],
    meaning:
      "Text and ancestor-aware GUI visibility, not rendered legibility or lack of occlusion.",
  },
  gui_geometry: {
    fields: ["exists", "visible", "x", "y", "width", "height"],
    meaning:
      "Absolute GUI rectangle and ancestor-aware visibility; rendered appearance still needs pixels.",
  },
  part_position: {
    fields: ["exists", "x", "y", "z"],
    meaning: "One world-space position sample, not a trajectory.",
  },
  part_physics: {
    fields: ["exists", "anchored", "canCollide"],
    meaning: "Anchored and CanCollide at collection time only.",
  },
  part_physics_trace: {
    fields: [
      "exists",
      "initialAnchored",
      "finalAnchored",
      "initialCanCollide",
      "finalCanCollide",
      "everUnanchored",
      "observedMs",
      "changes",
    ],
    meaning:
      "Records initial and final Anchored/CanCollide values and their bounded property-change callbacks on one measured clock. Every change contains elapsedMs, anchored and canCollide. everUnanchored includes an initially unanchored part. CanCollide transitions bound a collision-disabled interval; they do not prove actual player passage or callback timing more precise than engine scheduling. Point snapshots are unnecessary for the same window. Overflow or removed target raises incomplete acquisition. No claim extends beyond the measured window.",
  },
  part_route_trace: {
    fields: ["exists", "observedMs", "sampleCount", "maxFrameGapMs", "visits"],
    meaning:
      "Visits contain marker, enterMs/exitMs, travelStuds, minDistanceStuds, longestStillMs and maxFrameGapMs. Proximity is an acquisition aperture, not an authored threshold. Inspect timing gaps.",
  },
  particle_state: {
    fields: ["exists", "enabled", "emissionRate"],
    meaning: "Emitter configuration, not proof that rendered particles are visible.",
  },
  replication_probe: {
    fields: ["exists", "value", "observedFrom"],
    meaning:
      "exists=true establishes both the resolved instance and its named attribute at collection time. Role resolution enforces its declared class/scope. exists=false means the instance or attribute is absent, without distinguishing which; the fallback false value must not pass a comparison. Success does not by itself establish causal origin or replication history.",
  },
  actor_health: {
    fields: ["actor", "exists", "value"],
    meaning: "Observed humanoid health; unavailable actor is distinct from health zero.",
  },
  player_count: { fields: ["value"], meaning: "Connected player count at collection time." },
  diagnostics: {
    fields: ["messages", "scriptErrors"],
    meaning:
      "Bounded errors accumulated since before Play in the collecting execution context. Server and client contexts are separate; empty server channels cannot establish a clean client. " +
      DIAGNOSTIC_SEMANTICS,
  },
  performance_trace: {
    fields: ["samples"],
    meaning:
      "Server frame and memory samples from one Studio process on the development Mac. Each sample covers the interval since the previous sample: elapsedMs on the measured clock, frames, meanFrameMs and maxFrameMs from RunService.Heartbeat, instanceCount from Stats.InstanceCount and memoryMb from Stats:GetTotalMemoryUsageMb(). When Studio refuses the first read of instanceCount or memoryMb, every sample omits that field; a later refusal stops the trace as incomplete acquisition. Studio, its plugins and every Play context share the process, so the values are relative signals between builds on the same machine, not device performance and not a frame rate that players get.",
  },
  gui_layout: {
    fields: ["exists", "complete", "screen", "guiInset", "viewport", "ignoreGuiInset", "elements"],
    meaning:
      "Geometry and text fit of one ScreenGui of the local player at collection time, not its appearance. screen is the AbsolutePosition and AbsoluteSize of the ScreenGui as {x,y,w,h}; guiInset is GuiService:GetGuiInset() as left/top/right/bottom; viewport is the camera ViewportSize as {w,h}; ignoreGuiInset is the ScreenGui property. All values are GUI pixels, not capture pixels. elements holds at most 256 visible GuiObjects of this ScreenGui in path order. A GuiObject is visible when it and all its ancestors are Visible and the ScreenGui is Enabled. Each element has path, className, rect {x,y,w,h} from AbsolutePosition and AbsoluteSize, clippedRect (rect inside every ancestor with ClipsDescendants; absent when nothing of it stays), zIndex and hasText. An element with non-empty Text adds textBounds {w,h}, textSize, textScaled, textWrapped and textFits. complete=false means the limit left out elements. Rectangles ignore Rotation, transparency, images and occlusion; rendered pixels stay the authority for appearance. exists=false means no ScreenGui at the path; its zero fallback values must not pass a comparison.",
  },
} as const satisfies {
  [K in StudioObservation["kind"]]: {
    fields: readonly (keyof Extract<StudioObservation, { kind: K }>)[];
    meaning: string;
  };
};

export const ACTION_RECEIPT_SEMANTICS =
  "requestedAction is the exact input specification from the frozen plan, not proof of its effect. outcome tells if the step started in its horizon. scheduledAt is the time that the server published for the action. actedAt is the time that the actor started the action. Both times use the Studio server clock in seconds. Neither time tells when the effect occurred. Observe the effect in a later step that is anchored on a fixed anchor fact. The signed action outcome and independently timed observations remain distinct evidence.";

/**
 * The finding codes of the pinned luau-lsp: the Luau lint names, and three codes for errors.
 * `UnknownGlobal` is also the code of a type error about an unknown global. An analysis with
 * any other code is unavailable.
 */
export const SOURCE_LINT_CODES = [
  "UnknownGlobal",
  "DeprecatedGlobal",
  "GlobalUsedAsLocal",
  "LocalShadow",
  "SameLineStatement",
  "MultiLineStatement",
  "LocalUnused",
  "FunctionUnused",
  "ImportUnused",
  "BuiltinGlobalWrite",
  "PlaceholderRead",
  "UnreachableCode",
  "UnknownType",
  "ForRange",
  "UnbalancedAssignment",
  "ImplicitReturn",
  "DuplicateLocal",
  "FormatString",
  "TableLiteral",
  "UninitializedLocal",
  "DuplicateFunction",
  "DeprecatedApi",
  "TableOperations",
  "DuplicateCondition",
  "MisleadingAndOr",
  "CommentDirective",
  "IntegerParsing",
  "ComparisonPrecedence",
  "RedundantNativeAttribute",
  "TypeError",
  "SyntaxError",
] as const;

export type SourceLintCode = (typeof SOURCE_LINT_CODES)[number];

/** The fixed checks of the rule gui_layout_holds. Each check reads one gui_layout fact. */
export const GUI_LAYOUT_CHECKS = [
  "on_screen",
  "no_text_overlap",
  "text_fits",
  "min_text_px",
] as const;

export type GuiLayoutCheck = (typeof GUI_LAYOUT_CHECKS)[number];

/**
 * The metrics of the rule performance_within. Each metric reads one field of the samples of a
 * performance_trace fact. memory_mb is the memory of the whole Studio process.
 */
export const PERFORMANCE_METRICS = [
  "max_frame_ms",
  "mean_frame_ms",
  "instance_count",
  "memory_mb",
] as const;

export type PerformanceMetric = (typeof PERFORMANCE_METRICS)[number];

/** The aggregates of the rule performance_within over the samples of one trace. */
export const PERFORMANCE_AGGREGATES = ["max", "p95", "growth"] as const;

export type PerformanceAggregate = (typeof PERFORMANCE_AGGREGATES)[number];

/** The measures of the rule capture_exposure. Each measure reads all pixels of one capture. */
export const EXPOSURE_MEASURES = ["mean_luminance", "dark_share", "bright_share"] as const;

export type ExposureMeasure = (typeof EXPOSURE_MEASURES)[number];

/**
 * The deterministic rules that wait for a Studio spike. They are not in the catalog and not in
 * the tool schema, so preparation cannot map a criterion to them. A plan that a person writes can
 * use them. Move a rule to the catalog after its spike confirms the fact that it reads.
 */
export const SPIKE_PENDING_RULES = [
  "gui_layout_holds",
  "performance_within",
  "capture_text_contrast",
  "capture_exposure",
] as const;

/** Results of the anchor of one step in one context. Only a rubric bound makes expiry a failure. */
const STEP_OUTCOME_SEMANTICS = {
  observed:
    "The context saw the anchor and started the step in its horizon. anchorObservedAt is the first sighting; pollIntervalMs is its precision.",
  not_observed_within_horizon:
    "The context did not see the anchor in its horizon, or it could not start the step in its horizon. The step did no action and no capture. This is inconclusive. It becomes a failure only through a requirement.withinMs that a human rubric sets.",
  acquisition_failed:
    "The runner could not evaluate the anchor or did not receive the published schedule. This maps to incomplete.",
} as const;

/**
 * Platform-observable facts that a step can wait for. None of them reads a candidate attribute
 * or value, so a candidate cannot choose when the runner observes it.
 */
export const ANCHOR_FACT_SEMANTICS = {
  humanoid_state:
    "The Humanoid of the actor is in the named HumanoidStateType. Prefer the scope of the actor's own client: other contexts see a replicated state.",
  character_on_part:
    "A downward ray from the actor's HumanoidRootPart hits the declared BasePart. This is the support test of character_reach_part.",
  character_near_part:
    "The actor's HumanoidRootPart is at most radiusStuds from the box of the declared BasePart. The radius is an acquisition aperture, not a success threshold.",
  gui_visible:
    "The declared GuiObject of the scope client exists and has ancestor-aware visibility equal to visible. Use a client scope only.",
  instance_present:
    "The declared instance exists (present true) or does not exist (present false). An ambiguous or wrong-class role binding gives acquisition_failed.",
  part_can_collide: "The declared BasePart exists and its CanCollide value equals value.",
  part_anchored: "The declared BasePart exists and its Anchored value equals value.",
} as const;

/** Names of Enum.HumanoidStateType that a humanoid_state anchor can wait for. */
export const HUMANOID_STATES = [
  "Running",
  "RunningNoPhysics",
  "Jumping",
  "Freefall",
  "Landed",
  "Climbing",
  "Swimming",
  "Seated",
  "PlatformStanding",
  "FallingDown",
  "GettingUp",
  "Ragdoll",
  "Physics",
  "StrafingNoPhysics",
  "Flying",
  "Dead",
] as const;

/** Fixed runner vocabulary made available to the compiler; no generated callbacks. */
export const STUDIO_CAPABILITY_CATALOG = {
  planSchema: "basalt-evals/studio-plan",
  actionReceiptSemantics: ACTION_RECEIPT_SEMANTICS,
  stepOutcomes: STEP_OUTCOME_SEMANTICS,
  anchorFactResults: ANCHOR_FACT_SEMANTICS,
  observationResults: STUDIO_OBSERVATION_RESULTS,
  executionSemantics: {
    scenarios:
      "Each scenario runs in a fresh multiplayer Play. All contexts start from one shared clock after every actor is ready. Steps run in plan order. Each step has one anchor: at.after.fact (the first sighting of a fixed anchor fact in the scope context), at.after.step (the completion of an earlier step), or at.startMs (an offset from the shared start). The step starts offsetMs after its anchor. The runner looks for the anchor for horizonMs from the time the step becomes due. A fact must hold for holdMs before it counts. If the runner does not see the anchor in the horizon, or cannot start the step in the horizon after scheduledAt, the outcome is not_observed_within_horizon: the step does no action and no capture. That outcome is inconclusive, not a failure. The server schedules every action. The actor performs it once at the published time and never retries it. A context with observations in a fact-anchored step anchors them on its own first sighting of that fact, so replication lag is measured. The observations of one step and context start together at capturedAt and run in the background; they do not delay later steps. Observations of an action step in the actor context start after the action returns. durationMs is the outer observation budget: no step starts after it ends, and a scenario ends when its steps and observations finish. move_to returns when it issues a movement request, not on arrival: anchor the next step on character_on_part or character_near_part, not on a guessed delay. Use at.startMs only for a rubric claim about time from the scenario start. Each report records outcome, dueAt, anchorObservedAt, pollIntervalMs, scheduledAt, actedAt and capturedAt on the Studio server clock in seconds.",
    presentation:
      "All phases execute sequentially in ONE presentation Play, separate from every scenario Play. Avatar position, candidate state, GUI state and earlier phase actions persist between phases in that presentation session; scenario actions do not. Reproduce the interaction in presentation before capturing its consequences. A phase's facts run sequentially before its captures, so long observations can outlast transient feedback. Capture timing must reflect that schedule.",
  },
  renderedScenarios:
    "One primary scenario per capture retains separate signed rendered frame streams for EVERY declared actor through the sequence view (scenarioId, requiredTransitions, camera, viewport, maximumGapMs, frameBudget). Each stream binds its actor and runtime user ID; acquisition rejects missing actor streams. One two-client sequence therefore includes both players' GUI and world views, not only a primary client. Multiple inputs and actors share this scenario. Select sequence:true in a private criterion to consume those frames. Prefer state transitions as effect anchors. An effect that the recording never observes still yields a labelled last frame, so failure evidence does not need the success state. Frames retain measured intervals. For each transition and actor, presentation keeps the last frame before the anchor, the first frame after an observed state change, one frame after holdMs and the fewest frames across effectWindowMs that keep maximumGapMs. These required frames must fit in frameBudget, or the evidence is insufficient. The other effect-window frames and an even fill then complete frameBudget. Phase captures are a separate single-player presentation and cannot alone establish both clients' feedback.",
  roleClasses: [
    "Instance",
    "BasePart",
    "Model",
    "Folder",
    "RemoteEvent",
    "RemoteFunction",
    "GuiObject",
    "TextButton",
    "ImageButton",
    "TextBox",
    "TextLabel",
    "ParticleEmitter",
    "ValueBase",
    "ScreenGui",
  ],
  guiInputRoleClasses: ["GuiObject", "TextButton", "ImageButton", "TextBox", "TextLabel"],
  phaseDrivers: [
    "wait_for_session",
    "wait_for_fact",
    "wait_for_exists",
    "observe_from_actor",
    "gui_button",
    "character_move_to",
    "character_reach_part",
  ],
  phaseDriverSemantics: {
    wait_for_session: {
      input: "none",
      readiness: "The phase is running in Play; no candidate fact is required.",
      camera: "current player view",
    },
    wait_for_exists: {
      input: "none",
      readiness:
        "Repeatedly collect the fact named by readyFactId from THIS phase's facts until exists=true or the acquisition timeout. The fact is a live collector specification, not an earlier result or a dependency on phase completion. Supported kinds: instance, instance_name, replication_probe.",
      camera: "current player view",
    },
    wait_for_fact: {
      input: "none",
      readiness:
        "Repeatedly collect THIS phase's replication_probe named by readyFactId until its value matches readyValue or the acquisition timeout. This is not a dependency on an earlier phase.",
      camera: "current player view",
    },
    gui_button: {
      input: "Click the declared GUI button.",
      readiness:
        "After input, repeatedly collect THIS phase's replication_probe named by readyFactId until its value matches readyValue or the acquisition timeout.",
      camera: "current player view",
    },
    character_move_to: {
      input: "Request local avatar movement toward targetPath.",
      readiness:
        "After input, repeatedly collect THIS phase's replication_probe named by readyFactId until its value matches readyValue or the acquisition timeout.",
      camera: "current player view",
    },
    character_reach_part: {
      input: "Move the local avatar toward the declared BasePart.",
      readiness:
        "Poll the avatar's downward contact ray for that part. No readyFactId, candidate success attribute, or earlier phase result is required.",
      camera:
        "Capture the current player view after contact, including GUI and world feedback. An observe_from_actor phase is not additionally required to acquire interaction feedback.",
    },
    observe_from_actor: {
      input: "No avatar or scene movement.",
      readiness:
        "Wait for a live avatar/camera, then poll target existence. Declare a same-phase instance fact for targetPath.",
      camera:
        "Aim from the actual avatar head at targetPath; retain viewpoint and target provenance. Use for spatial visibility from a declared player location, not as a universal prerequisite for every rendered capture.",
    },
  },
  anchorFacts: [
    "humanoid_state",
    "character_on_part",
    "character_near_part",
    "gui_visible",
    "instance_present",
    "part_can_collide",
    "part_anchored",
  ],
  humanoidStates: HUMANOID_STATES,
  scenarioActions: [
    "wait",
    "move_to",
    "place_on_part",
    "place_relative_to_part",
    "move_relative_to_part",
    "probe_barrier",
    "press_key",
    "hold_key",
    "gui_activate",
    "gui_text_entry",
    "fire_remote",
    "disconnect",
  ],
  observations: [
    "instance",
    "instance_name",
    "instance_value",
    "part_motion",
    "actor_part_motion",
    "actor_part_support",
    "part_position",
    "part_physics",
    "part_physics_trace",
    "part_route_trace",
    "gui_text",
    "gui_geometry",
    "particle_state",
    "replication_probe",
    "actor_health",
    "player_count",
    "diagnostics",
    "performance_trace",
    "gui_layout",
  ],
  deterministicRules: [
    "path_exists",
    "source_contains",
    "fact_equals",
    "fact_contains",
    "number_in_range",
    "diagnostics_empty",
    "capture_present",
    "scenario_action_succeeded",
    "scenario_barrier_passage",
    "scenario_fact_equals",
    "scenario_fact_supports_value",
    "scenario_fact_equals_actor_user_id",
    "scenario_number_delta_in_range",
    "scenario_cross_context_equals",
    "scenario_step_within",
    "source_lint_absent",
    "build_errors_absent",
    // gui_layout_holds joins this list after the connector spike confirms gui_layout. Until
    // then it is in SPIKE_PENDING_RULES, and only a plan that a person writes can use it.
    // The performance rule and the two pixel rules of captures wait for the same spike.
  ],
  supported: [
    "static_capture",
    "actor_view_capture",
    "state_observation",
    "movement",
    "actor_placement",
    "part_motion",
    "actor_part_motion",
    "actor_part_support",
    "multiplayer",
    "remote_input",
    "timing",
    "physical_passage",
    "gui_activation",
    "gui_text_entry",
    "gui_geometry",
    "part_position",
    "part_physics",
    "part_physics_trace",
    "part_route_trace",
    "key_hold",
    "semantic_role_binding",
    "source_lint",
  ],
  unavailable: ["data_store_persistence"],
  constraints: [
    "Instance is the least restrictive role class and supports naming, presence, and attribute observations on any Roblox instance. Choose it when the author requires an object or attribute container without a concrete class. Choose a narrower class only when required by authored behavior or the selected physical/GUI operation, and retain that acquisition limitation separately from human success.",
    "Use canonical JSON only; no Lua evaluator source, expressions, callbacks or arbitrary properties.",
    "gui_activate sends one center-point pointer down/up pair to a public GuiObject role. A GuiButton acknowledges Activated; a custom GuiObject acknowledges receipt of both input events. Neither acknowledgment proves the requested mechanic ran. Observe subsequent behavior independently. Use GuiObject when the prompt permits any clickable GUI implementation, TextBox for text entry, and narrower widget classes only when authored. Instance and non-GUI role classes cannot bind GUI input.",
    "A static view can use wait_for_session and zero required transitions.",
    "observe_from_actor waits for a declared target, then captures from the actual local actor's head, aimed at the target BasePart or Model bounds without moving the actor, target, or obstacles. Its same-phase instance fact records target availability. Missing targets still produce evidence; missing actor/camera is incomplete acquisition. Actual viewpoint and target positions are traced. Aiming is acquisition, not player interaction or proof of visibility; use the rendered pixels and provenance. Do not turn an invented fixed world camera into an authored viewing restriction.",
    "Acquisition readiness must not require the candidate's expected success value.",
    "character_reach_part moves the local avatar toward a declared BasePart and captures after its downward contact ray hits that part; it is presentation acquisition, not a deterministic proof of the mechanic's causal effect.",
    "readyFactId always resolves a live collector specification in the same phase. The runner invokes that collector while waiting, before collecting final facts and screenshots; this is not circular readiness. A readiness timeout still collects final facts and frames while acquisition remains healthy. It does not prove an authored failure deadline.",
    "Missing public instances are candidate contract failures only when capture machinery is healthy.",
    "Samples establish only timing supported by their measured acquisition intervals.",
    "Scenarios may declare up to 30 minutes; motion observations may sample up to ten minutes when the requested behavior needs a longer cycle. A slow candidate outside the measured window yields insufficient evidence, not a behavioral failure.",
    "Actor-part motion samples the player character root and target part on the same clock, including the target footprint and actor position in the part's local frame. That geometry, independently observed support, and bounded relative displacement after controlled placement can support a carry claim; co-motion alone cannot.",
    "place_on_part positions a test actor over a declared BasePart to isolate carry behavior from pathfinding; it does not by itself prove stable physical support. Require approach or boarding acquisition only when authored behavior includes it.",
    "place_relative_to_part positions a test actor at offsetStuds [x,y,z] in a declared BasePart's local coordinate frame. It establishes controlled near/far setup independent of candidate layout, not player reachability or a success condition. Bind actor_part_motion with sampleCount 1 to observe actual relative geometry at the input; do not assume spawn is far from a candidate-created target. Each offset coordinate is finite and bounded to 10000 studs.",
    "move_relative_to_part requests ordinary humanoid walking toward offsetStuds [x,y,z] in the declared BasePart's local frame, with the same coordinate bounds as placement. It neither teleports the actor nor creates corridor walls. Pair initial relative placement with a walking request to the opposite side and actor_part_motion traces to observe actual crossing when probe_barrier's fixed corridor is unsuitable. Samples include part size and actor-local coordinates, so inspect the route: going around an edge, falling, starting inside the part, or insufficient travel cannot establish passage through the barrier. The receipt proves only the walking request, never arrival or obstruction. Preserve insufficient evidence when the acquired geometry or duration cannot distinguish outcomes.",
    "probe_barrier positions its actor on one side of the declared barrier, installs temporary invisible corridor walls, requests crossing, records 2.5 seconds of measured movement, and removes the walls. It does not need a preceding move_to, place_on_part or actor_part_support observation to establish its own setup. It leaves the actor at the measured final position; restore near/far input geometry before a later interaction. The current probe supports a level rectangular Workspace BasePart with width at least 8, height at least 5 and depth at least 0.5 studs. These are acquisition limitations, not authored success thresholds; incompatible geometry cannot justify an authored failure. A Model is not directly accepted as barrierPath.",
    "actor_part_support records target-local actor geometry and an unobstructed downward contact ray after placement; a miss may be insufficient when another legitimate support carries the avatar.",
    "part_physics_trace observes both Anchored and CanCollide changes over a measured scenario window. Start the trace in a step before the input: observations run in the background, so the trace overlaps the later action. Use the trace for timed collision changes instead of isolated snapshots. Physical passage still needs independent movement evidence. An initially unanchored part sets everUnanchored=true even without a change event.",
    "Anchor facts come only from the fixed anchorFacts vocabulary: Humanoid state, character support or position, on-screen GUI presence, and part presence, CanCollide or Anchored. Never anchor on a candidate attribute or value: the candidate would then control when the runner observes. Use replication_probe only as an observation.",
    "after.step must name an earlier step. after.fact needs a scope: server or an actor in reportContexts. A gui_visible anchor needs a client scope, and its step can observe only in that scope. Put an action actor in reportContexts when its receipt, its actedAt or a later requirement matters. A disconnect actor cannot report.",
    "horizonMs is at most 60000, like the phase driver timeouts. holdMs is less than horizonMs and only applies to a fact anchor. Expiry of the horizon means not observed, not failure. A longer horizon or a longer budget does not invent a deadline.",
    "A drafted step always has requirement null. Only a person adds a pass/fail time bound from rubric text.",
    "An action is never retried. Only observations repeat: the runner polls an anchor fact each frame until it holds or the horizon ends.",
    "part_route_trace samples each Studio frame and summarizes visits to two declared public markers, including measured dwell, movement within the zone, acquisition gaps, and stable-position intervals. The proximity radius is an observation aperture, not a hidden pass threshold; a missing visit or inadequate window can yield insufficient evidence.",
    "A diagnostics fact contains bounded errors accumulated from before Play started until that fact is collected. Collect it after the behavior window to cover the observed session; attribution to the mechanic remains a separate judgment.",
    "source_lint_absent is a static check of the sealed source with the pinned luau-lsp, Basalt's fixed Luau configuration and the Rojo sourcemap. It names 1 to 16 distinct codes: Luau lint names, TypeError, SyntaxError, and UnknownGlobal, which also covers the type error for an unknown global. Basalt ignores candidate Luau configuration and neutralizes --!nolint and --!nocheck. Any finding of a named code rejects; an unavailable analysis is incomplete. Use it only when an authored passage names a static code property, such as no deprecated wait, spawn or delay (DeprecatedApi). A lint result proves nothing about runtime behavior.",
    "build_errors_absent attributes each scriptErrors entry of its bound diagnostics facts with fixed rules: the engine source path, the stack frames and the build scripts of the sealed sourcemap, with the Studio copies of StarterPlayerScripts, StarterCharacterScripts, StarterGui and StarterPack scripts for each actor. An error from a script outside the place is external. One build error rejects. An error of unknown origin, a full channel or an absent fact is incomplete. It reads no output messages. Bind a diagnostics fact of the server and of each client after the behavior window, because each context keeps its own errors. It covers only the bound contexts and the observed session.",
    "When public route markers or endpoints define behavior, public development should observe their positions rather than leave marker geometry only in private evaluation.",
    "Candidate-created objects use public role.<id> references resolved by the CollectionService tag that equals the role id, the class and the scope. Supplied neutral scene objects may use their declared game.Workspace.<name> paths without candidate tags. A Player-owned object or attribute uses a game.Players.LocalPlayer.<path> path, only in the client context of its actor. Their generated marker names are setup identities, not new human success criteria.",
    "Role cardinality constrains observation binding, not human requiredness. exactly_one records a binding failure when absent; zero_or_one permits recording absence without a binding failure, including a required object before the candidate creates it. Neither cardinality weakens the public request or human rubric. Presence and behavior still need mapped evidence, and an absent object cannot pass a false/zero comparison. Do not infer that an authored requirement became optional merely because an acquisition binding permits absence.",
    "An instance_name observation can confirm the actual name of a tagged candidate object when the public request names it; the tag alone does not prove that name.",
    "performance_trace is a scenario observation in the server context only. It takes sampleCount samples, one after each intervalMs of at least 250, so its window is sampleCount * intervalMs. gui_layout is a client observation, in a phase or in the scenario context of an actor. Its path is a local_player_gui ScreenGui role or a game.Players.LocalPlayer.PlayerGui.<name> path. A ScreenGui role needs the local_player_gui scope, and it cannot bind GUI input.",
  ],
} as const;
