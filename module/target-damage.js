class TargetDamageTarget {
	constructor(target) {
		this.id = target.id;
		this.roll = target.roll;
		this.tokenUuid = target.tokenUuid;
		this.actorUuid = target.actorUuid;
	}

	// returns the DOCUMENT
	get token() {
		return fromUuidSync(this.tokenUuid);
	}

	// returns the DOCUMENT
	get actor() {
		return fromUuidSync(this.actorUuid);
	}

	get visibility() {
		// If false, only the GM can see it. If true, everyone can see it.
		return game.settings.get("pf2e-target-damage", "hideNPCs") ? this.token.hasPlayerOwner : true;
	}

	get mystified() {
		// If false, only the GM can see it and players see it mystified.
		return game.settings.get("pf2e", "metagame_tokenSetsNameVisibility") ? this.token.playersCanSeeName : true;
	}

	get isOwner() {
		return this.token.isOwner;
	}

	get name() {
		// If tokens set name visibility and the players can't see the name and the user isn't a GM, hide the name.
		return !this.mystified && !game.user.isGM
			? game.i18n.localize("pf2e-target-damage.hidden")
			: this.token.name ?? this.actor.name;
	}

	get img() {
		return fromUuidSync(this.tokenUuid)?.texture.src ?? fromUuidSync(this.actorUuid)?.prototypeToken.texture.src;
	}
}

// Flag what targets were at the time of the roll
Hooks.on("preCreateChatMessage", (message) => {
	if (message?.flags?.["pf2e-target-damage"]?.targets) return;
	if (message.rolls[0]?.options.evaluatePersistent) {
		message.updateSource({
			"flags.pf2e-target-damage.targets": [message.token.object].map((target) => {
				return {
					id: target.id,
					tokenUuid: target.document.uuid,
					actorUuid: target.actor.uuid,
				};
			}),
		});
	} else {
		message.updateSource({
			"flags.pf2e-target-damage.targets": Array.from(game.user.targets).map((target) => {
				return {
					id: target.id,
					tokenUuid: target.document.uuid,
					actorUuid: target.actor.uuid,
				};
			}),
		});
	}
});

Hooks.on("createChatMessage", (message) => {
	if (!game.user.isGM) return;
	const rollOption = message?.flags?.pf2e?.context?.options?.filter(x => x.includes("pf2e-td"))
	if (rollOption?.length > 0) {
		rollOption.forEach((option) => {
			const id = option.split("pf2e-td-")[1];
			const saveMessage = game.messages.get(id);

			const newFlag = saveMessage.flags["pf2e-target-damage"].targets;
			const index = newFlag.findIndex((target) => target.id === message.token.id)
			newFlag[index].roll = message.id;

			saveMessage.update({
				"flags.pf2e-target-damage.targets": newFlag
			});
			ui.chat.updateMessage(saveMessage, true)
		})
	}
});

//#region borrowed from PF2e system, document.ts#210
function onHoverIn(token, event) {
	if (!canvas.ready) return;
	token = token?.object ?? token;
	if (token?.isVisible && !token.controlled) {
		token.emitHoverIn();
	}
}

function onHoverOut(token, event) {
	token = token?.object ?? token;
	if (canvas.ready) token?.emitHoverOut();
}

function onClickSender(token, event) {
	if (!canvas) return;
	token = token?.object;
	if (token?.isVisible) {
		if (token.isOwner) {
			token.controlled ? token.release() : token.control({ releaseOthers: !event.shiftKey });
		} else {
			token.setTarget(!token.isTargeted, { releaseOthers: !event.shiftKey })
		}
		// If a double click, also pan to the token
		if (event.type === "dblclick") {
			const scale = Math.max(1, canvas.stage.scale.x);
			canvas.animatePan({ ...token.center, scale, duration: 1000 });
		}
	}
}
//#endregion

function updateMessageWithFlags(event, message) {
	event.stopPropagation();
	const targetsFlags = message.flags["pf2e-target-damage"].targets;
	const targetsCurrent = Array.from(game.user.targets);
	const targetsFinal = [];

	if (!targetsCurrent.length) return;

	if (game.settings.get("pf2e-target-damage", "targetButton")) {
		if (event.shiftKey) {
			targetsFinal.push(...targetsFlags);
			targetsFinal.push(...targetsCurrent);
		} else {
			targetsFinal.push(...targetsCurrent);
		}
	} else {
		if (event.shiftKey) {
			targetsFinal.push(...targetsCurrent);
		} else {
			targetsFinal.push(...targetsFlags);
			targetsFinal.push(...targetsCurrent);
		}
	}

	message.update({
		"flags.pf2e-target-damage.targets": targetsFinal.map((target) => {
			return {
				id: target.id,
				tokenUuid: target.tokenUuid || target.document.uuid,
				actorUuid: target.actorUuid || target.actor.uuid,
			};
		}),
	});
}

async function applyDamage(message, tokenID, multiplier, addend = 0, promptModifier = false, rollIndex = 0) {
	if (promptModifier) return shiftModifyDamage(message, tokenID, multiplier, rollIndex);
	// Modified here to include TokenID
	const tokens = canvas.tokens.ownedTokens.filter((token) => token.document._id === tokenID && token.actor);
	// End modif
	if (tokens.length === 0) {
		const errorMsg = game.i18n.localize("pf2e-target-damage.error.cantFindToken");
		ui.notifications.error(errorMsg);
		return;
	}

	const shieldBlockRequest = CONFIG.PF2E.chatDamageButtonShieldToggle;
	const roll = message.rolls.at(rollIndex);

	if (!(roll instanceof DamageRoll)) throw Error("Unexpected error retrieving damage roll");

	const damage = multiplier < 0 ? multiplier * roll.total + addend : roll.alter(multiplier, addend);

	for (const token of tokens) {
		await token.actor?.applyDamage({
			damage,
			token: token.document,
			skipIWR: multiplier <= 0,
			rollOptions: new Set(message.flags.pf2e.context?.options ?? []),
			shieldBlockRequest,
		});
	}
	toggleOffShieldBlock(message.id);
}

function shiftModifyDamage(message, tokenID, multiplier, rollIndex) {
	new Dialog({
		title: game.i18n.localize("PF2E.UI.shiftModifyDamageTitle"),
		content: `<form>
				<div class="form-group">
					<label>${game.i18n.localize("PF2E.UI.shiftModifyDamageLabel")}</label>
					<input type="number" name="modifier" value="" placeholder="0">
				</div>
				</form>
				<script type="text/javascript">
				$(function () {
					$(".form-group input").focus();
				});
				</script>`,
		buttons: {
			ok: {
				label: "Ok",
				callback: async ($dialog) => {
					// In case of healing, multipler will have negative sign. The user will expect that positive
					// modifier would increase healing value, while negative would decrease.
					const adjustment = (Number($dialog.find('[name="modifier"]').val()) || 0) * Math.sign(multiplier);
					applyDamage(message, tokenID, multiplier, adjustment, false, rollIndex);
				},
			},
		},
		default: "ok",
		close: () => {
			toggleOffShieldBlock(message.id);
		},
	}).render(true);
}
/** Toggle off the Shield Block button on a damage chat message */
function toggleOffShieldBlock(messageId) {
	const $message = $(`#chat-log > li.chat-message[data-message-id="${messageId}"]`);
	const $button = $message.find("button.pf2e-td-shield-block");
	$button.removeClass("shield-activated");
	CONFIG.PF2E.chatDamageButtonShieldToggle = false;
}

function tokensInRange(target, range = 5) {
	const allTokens = canvas.tokens.placeables;
	// Get all tokens that are within range of the target
	const splashedTokens = allTokens.filter((x) => target.distanceTo(x) <= range);
	return splashedTokens;
}

const DamageRoll = CONFIG.Dice.rolls.find((R) => R.name === "DamageRoll");

Hooks.on("renderChatMessage", (message, html) => {
	setTimeout(() => {
		html = html.find(".message-content");
		const targets = message.flags["pf2e-target-damage"]?.targets?.map((target) => new TargetDamageTarget(target)) || [];
		const rolls = message.rolls.filter((roll) => roll instanceof DamageRoll);

		rolls.forEach(async (roll, index, array) => {
			if (roll.options.splashOnly) {
				const splashSection = $(html.find(`.dice-roll.damage-roll`)[index]);
				splashSection.find(".dice-total").prepend(
					$(
						`<button class='pf2e-td splash-button small-button' title="${game.i18n.localize(
							"pf2e-target-damage.splashButton.hint"
						)}"><i class='fa-solid fa-bomb fa-fw'></i></button>`
					).on({
						click: (e) => {
							const target = (targets.map((t) => t.token.object) ?? Array.from(game.user.targets))[0];
							if (!target) return;

							// Increase Radius Dialogue
							let multiplier = 5;

							if (message.flags.pf2e?.context?.options.includes("feat:expanded-splash")) multiplier = 10;

							if (e.shiftKey) {
								new Dialog({
									title: game.i18n.localize("pf2e-target-damage.splashButton.radiusDialog.title"),
									content: `<form>
												<div class="form-group">
													<label>${game.i18n.localize("pf2e-target-damage.splashButton.radiusDialog.content")}</label>
													<input type="number" name="modifier" value="" placeholder="${multiplier} feet">
												</div>
												</form>
												<script type="text/javascript">
												$(function () {
													$(".form-group input").focus();
												});
												</script>`,
									buttons: {
										ok: {
											label: game.i18n.localize("CONTROLS.CanvasSelectAll"),
											callback: async ($dialog) => {
												multiplier = Number($dialog.find('[name="modifier"]').val()) || multiplier;
												tokensInRange(target, multiplier).filter(x => x !== target).forEach((x) => x.control({ releaseOthers: false }));
											},
										},
									},
									default: "ok",
								}).render(true);
							} else {
								tokensInRange(target, multiplier).filter(x => x !== target).forEach((x) => x.control({ releaseOthers: false }));
							}
						},
						// Doesn't highlight everything
						//mouseenter: (e) => {tokensInRange((targets.map(t => t.token.object) ?? Array.from(game.user.targets))[0], 5).forEach(t => onHoverIn(t, e))},
						//mouseleave: (e) => {tokensInRange((targets.map(t => t.token.object) ?? Array.from(game.user.targets))[0], 5).forEach(t => onHoverOut(t, e))},
					})
				);
				return;
			}

			const damageSection = $(html.find(`.dice-roll.damage-roll`)[index]);
			damageSection.find(".dice-total").prepend(
				$(
					`<button class='pf2e-td target-button small-button' title="${game.i18n.localize(
						"pf2e-target-damage.targetButton.hint-" + game.settings.get("pf2e-target-damage", "targetButton")
					)}"><i class='fa-solid fa-crosshairs-simple fa-fw'></i></button>`
				).click((e) => updateMessageWithFlags(e, message))
			);

			if (targets.length) {
				html
					.find($('section[data-roll-index="' + index + '"]'))
					.after(`<hr class='pf2e-td' data-roll-index="${index}"></hr>`);

				// Add target and hiding buttons
				damageSection.find(".dice-total").append(
					$(
						`<button class='pf2e-td hide-button small-button' title="${game.i18n.localize(
							"pf2e-target-damage.hideButton"
						)}"><i class='fa fa-minus fa-fw'></i></button>`
					).click(function (e) {
						html.find($('section[data-roll-index="' + index + '"]')).slideToggle(350);
						html.find($("hr.pf2e-td")).slideToggle(500);
						$(this).find(".fa").toggleClass("fa-plus fa-minus");
						e.stopPropagation();
					})
				);

				const buttonTemplate = $(
					await renderTemplate("modules/pf2e-target-damage/templates/buttons.html", {
						showTripleDamage: game.settings.get("pf2e", "critFumbleButtons"),
					})
				);

				const buttonTemplates = [];

				// Add button template for each target to buttonTemplates
				for (let i = 0; i < targets.length; i++) {
					const target = targets[i];
					const targetTemplate = $(buttonTemplate.clone());
					const nameHTML = targetTemplate.find(".pf2e-td.name");
					const tokenID = target.token.id;

					// replace stuff in template
					nameHTML.text(target.name);
					nameHTML.mouseenter((e) => onHoverIn(target.token, e));
					nameHTML.mouseleave((e) => onHoverOut(target.token, e));
					nameHTML.click((e) => onClickSender(target.token, e));
					nameHTML.dblclick((e) => onClickSender(target.token, e));
					// targetTemplate.find(".pf2e-td.image").attr("src", target.img);
					// targetTemplate.find(".pf2e-td.image").attr("title", target.name);

					// this is really just to let the GM know the targets are mystified or hidden
					if (game.user.isGM) {
						if (!target.visibility) {
							targetTemplate.find(".damage-application").attr("data-visibility", "gm");
						} else if (!target.mystified) {
							targetTemplate.find(".pf2e-td.name").attr("data-visibility", "gm");
						}
					} else {
						if (!target.visibility) return;
					}

					if (game.settings.get("pf2e-target-damage", "classic")) {
						$(targetTemplate[0]).addClass("name-top");
					} else {
						$(targetTemplate[0]).addClass("name-left");
					}

					if (!target.isOwner) {
						targetTemplate.find("button.pf2e-td").remove();
						targetTemplate.find("hover-content").remove();
						$(targetTemplate[0]).addClass("name-top").removeClass("name-left");
					}

					//#region The Buttons
					const full = targetTemplate.find("button.pf2e-td.full-damage");
					const half = targetTemplate.find("button.pf2e-td.half-damage");
					const double = targetTemplate.find("button.pf2e-td.double-damage");
					const triple = targetTemplate.find("button.pf2e-td.triple-damage");
					const heal = targetTemplate.find("button.pf2e-td.heal-damage");
					const contentSelector = `li.chat-message[data-message-id="${message.id}"] div.hover-content`;
					const $shield = targetTemplate
						.find("button.pf2e-td.shield-block")
						.attr({ "data-tooltip-content": contentSelector })
						.tooltipster({
							animation: "fade",
							trigger: "click",
							arrow: false,
							contentAsHtml: true,
							interactive: true,
							side: ["top"],
							theme: "crb-hover",
						});
					$shield.tooltipster("disable");

					// Add click events to apply damage
					full.on("click", (event) => {
						applyDamage(message, tokenID, 1, 0, event.shiftKey, index);
					});

					half.on("click", (event) => {
						applyDamage(message, tokenID, 0.5, 0, event.shiftKey, index);
					});

					double.on("click", (event) => {
						applyDamage(message, tokenID, 2, 0, event.shiftKey, index);
					});

					triple === null || triple === void 0
						? void 0
						: triple.on("click", (event) => {
							applyDamage(message, tokenID, 3, 0, event.shiftKey, index);
						});

					heal.on("click", (event) => {
						applyDamage(message, tokenID, -1, 0, event.shiftKey, index);
					});

					$shield.on("click", async (event) => {
						const tokens = canvas.tokens.ownedTokens.filter((token) => token.id === tokenID && token.actor);
						if (tokens.length === 0) {
							const errorMsg = game.i18n.localize("PF2E.UI.errorTargetToken");
							ui.notifications.error(errorMsg);
							event.stopPropagation();
							return;
						}
						// If the actor is wielding more than one shield, have the user pick which shield to block for blocking.
						const actor = tokens[0].actor;
						const heldShields = actor.itemTypes.armor.filter((armor) => armor.isEquipped && armor.isShield);
						const nonBrokenShields = heldShields.filter((shield) => !shield.isBroken);
						const multipleShields = tokens.length === 1 && nonBrokenShields.length > 1;
						const shieldActivated = $shield.hasClass("shield-activated");
						if (multipleShields && !shieldActivated) {
							$shield.tooltipster("enable");
							// Populate the list with the shield options
							const $list = targetTemplate.find("ul.shield-options");
							$list.children("li").remove();
							const $template = $list.children("template");
							for (const shield of nonBrokenShields) {
								const $listItem = $($template.html());

								$listItem.children("input.data").val(shield.id);
								$listItem.children("span.label").text(shield.name);
								const hardnessLabel = game.i18n.localize("PF2E.ShieldHardnessLabel");
								$listItem.children("span.tag").text(`${hardnessLabel}: ${shield.hardness}`);

								$list.append($listItem);
							}
							$list.find("li input").on("change", (event) => {
								const $input = $(event.currentTarget);
								$shield.attr({ "data-shield-id": $input.val() });
								$shield.tooltipster("close").tooltipster("disable");
								$shield.addClass("shield-activated");
								CONFIG.PF2E.chatDamageButtonShieldToggle = true;
							});
							$shield.tooltipster("open");
							return;
						} else {
							$shield.tooltipster("disable");
							$shield.removeAttr("data-shield-id");
							event.stopPropagation();
						}
						$shield.toggleClass("shield-activated");
						CONFIG.PF2E.chatDamageButtonShieldToggle = !CONFIG.PF2E.chatDamageButtonShieldToggle;
					});

					//#endregion

					// push
					buttonTemplates.push(targetTemplate);
				}

				// Sort the buttons by the number of buttons they have, so that the ones with the most buttons are at the top.
				buttonTemplates.sort((a, b) => {
					const aButtons = a.find("button.pf2e-td").length;
					const bButtons = b.find("button.pf2e-td").length;

					return bButtons - aButtons;
				});

				html.find($('hr[data-roll-index="' + index + '"]')).after(buttonTemplates);
			}
		});

		if (targets.length && (game.settings.get("pf2e-target-damage", "hideOGButtons") || (message.rolls[0]?.options.evaluatePersistent && game.settings.get("pf2e-target-damage", "persistentDamageInt")))) {
			// Hide the original buttons, whether it's the main one or the persistent damage one.
			html.find(".pf2e-td.hide-button").trigger("click");
		}
		if (game.settings.get("pf2e-target-damage", "hideTheHidingButtons")) {
			// REMOVE the original buttons, whether it's the main one or the persistent damage one.
			html.find(".pf2e-td.hide-button").remove();
		}

		// Not a damage roll, proceed with Target Saves
		if (rolls.length < 1) {
			const targetSection = $(html.find(`[data-action="spellTemplate"]`));
			targetSection.parent().addClass("pf2e-td target-section");
			targetSection.before(
				$(
					`<button class='pf2e-td target-button small-button' title="${game.i18n.localize(
						"pf2e-target-damage.targetButton.hint-" + game.settings.get("pf2e-target-damage", "targetButton")
					)}"><i class='fa-solid fa-crosshairs-simple fa-fw'></i></button>`
				).click((e) => updateMessageWithFlags(e, message))
			);
			if (message.flags?.pf2e?.origin?.type === "spell") {
				const spell = fromUuidSync(message.flags.pf2e.origin.uuid);
				const save = spell.system?.save?.value
				if (!save) return; // Not a saving throw spell

				const buttonTemplate = $(`<wrapper class="pf2e-td"><span class="pf2e-td name"></span><button class="pf2e-td save"></button></wrapper>`);

				const buttonTemplates = []

				for (let i = 0; i < targets.length; i++) {
					const target = targets[i];
					const targetTemplate = $(buttonTemplate.clone());
					const nameHTML = targetTemplate.find(".pf2e-td.name");
					const saveHTML = targetTemplate.find(".pf2e-td.save");

					// replace stuff in template
					nameHTML.text(target.name);
					nameHTML.mouseenter((e) => onHoverIn(target.token, e));
					nameHTML.mouseleave((e) => onHoverOut(target.token, e));
					nameHTML.click((e) => onClickSender(target.token, e));
					nameHTML.dblclick((e) => onClickSender(target.token, e));

					if (target.roll && game.messages.get(target.roll)) {
						const outcome = game.messages.get(target.roll).flags.pf2e.context.outcome;
						saveHTML.text(outcome ? game.i18n.localize(`PF2E.Check.Result.Degree.Check.${outcome}`) : "Error!");
						saveHTML.addClass(outcome)
					} else {
						saveHTML.text(game.i18n.format("PF2E.SavingThrowWithName", { saveName: game.i18n.localize(`PF2E.Saves${save.charAt(0).toUpperCase() + save.slice(1)}`)}))
					}

					saveHTML.click((e) => {
						const item = spell;
						const actor = target.actor;

						const saveType = item.system.save.value;

						const dc = Number(html.find('[data-action="save"]').attr("data-dc") ?? "NaN");
            			const itemTraits = item.system.traits?.value ?? [];

						const save = actor?.saves?.[saveType];
                		if (!save) return;

						const rollOptions = [];
						if (item.isOfType("spell")) {
							rollOptions.push("magical", "spell");
							if (Object.keys(item.system.damage.value).length > 0) {
								rollOptions.push("damaging-effect");
							}
						}

						rollOptions.push(...itemTraits);

						rollOptions.push("pf2e-td-" + message.id)

						function eventToRollParams(event) {
							var skipDefault = !game.user.settings.showRollDialogs;
							if (!event)
								return { skipDialog: skipDefault };
							var params = { skipDialog: event.shiftKey ? !skipDefault : skipDefault };
							if (event.ctrlKey || event.metaKey)
								params.rollMode = "blindroll";
							return params;
						}

						const rollParams = {
							...eventToRollParams(e),
							dc: Number.isInteger(dc) ? { value: Number(dc) } : null,
							item,
							origin: actor,
							extraRollOptions: rollOptions,
						};

						save.check.roll(rollParams);
					})

					// this is really just to let the GM know the targets are mystified or hidden
					if (game.user.isGM) {
						if (!target.visibility) {
							targetTemplate.find("wrapper.pf2e-td").attr("data-visibility", "gm");
						} else if (!target.mystified) {
							targetTemplate.find(".pf2e-td.name").attr("data-visibility", "gm");
						}
					} else {
						if (!target.visibility) return;
					}

					if (game.settings.get("pf2e-target-damage", "classic")) {
						$(targetTemplate[0]).addClass("name-top");
					} else {
						$(targetTemplate[0]).addClass("name-left");
					}

					if (!target.isOwner) {
						targetTemplate.find("button.pf2e-td").remove();
						targetTemplate.find("hover-content").remove();
						$(targetTemplate[0]).addClass("name-top").removeClass("name-left");
					}

					buttonTemplates.sort((a, b) => {
						const aButtons = a.find("button.pf2e-td").length;
						const bButtons = b.find("button.pf2e-td").length;

						return bButtons - aButtons;
					});

					buttonTemplates.push(targetTemplate)
				}
				const originalHeight = html.height();
				html.find(".card-buttons").append(buttonTemplates)
				$(document).find("#chat-log")[0].scrollBy(0, (html.height() - originalHeight), { behavior: "smooth" })
			}
		}

		// Scroll down to the last roll
		setTimeout(() => {
			if (rolls.length > 0) { // Only on damage rolls
				const lastRoll = html.find("wrapper.pf2e-td").last();
				if (lastRoll.length) {
					lastRoll[0].scrollIntoView({ behavior: "smooth" });
				}
			}
		}, 0);
	}, 0);
});
