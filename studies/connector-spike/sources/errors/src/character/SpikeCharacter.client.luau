--!strict
-- Error control of the connector spike: a deliberate error in a LocalScript of
-- StarterCharacterScripts. It runs on the client in the character model.
task.wait(1)
error("SPIKE-C-CHARACTER error in a LocalScript in StarterCharacterScripts")
