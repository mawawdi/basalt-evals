--!strict

-- Declared visibility through the hierarchy, not a claim about occlusion,
-- transparency or legibility. Rendered evidence remains authoritative for those.
return function(instance: Instance): boolean
	local current: Instance? = instance
	while current do
		if current:IsA("GuiObject") and not current.Visible then return false end
		if current:IsA("LayerCollector") and not current.Enabled then return false end
		current = current.Parent
	end
	return true
end
