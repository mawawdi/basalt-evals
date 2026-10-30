--!strict
-- Error control of the connector spike: a deliberate error in a server Script of
-- StarterCharacterScripts. It runs on the server in the character model.
task.wait(1)
error("SPIKE-S-CHARACTER error in a server Script in StarterCharacterScripts")
