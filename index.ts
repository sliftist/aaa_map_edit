import * as fs from "fs";
import * as zlib from "zlib";
import * as zip from "jszip";

const SPECIAL_PREFIX = "&&";

function stripXmlComments(xml: string) {
    let output = "";
    let inComment = false;
    for(let i = 0; i < xml.length; i++) {
        if(xml.slice(i, i + "<!--".length) === "<!--") {
            inComment = true;
        }
        if(!inComment) {
            output += xml[i];
        }
        if(inComment && (xml.slice(i - "-->".length + 1, i + 1) === "-->")) {
            inComment = false;
        }
    }
    return output;
}

function parseRawTags(xml: string): string[] {
    let tags: string[] = [];
    let specialTag = false;
    let curTag: string|undefined = undefined;

    xml = stripXmlComments(xml);

    for(let i = 0; i < xml.length; i++) {
        let ch = xml[i];
        if(!specialTag && ch === "<") {
            if(typeof curTag === "string") {
                throw new Error(`Starting new tag with old tag still open, ${xml.slice(i, i + 100)}`);
            }
            if(xml.slice(i, i + "<![".length) === "<![") {
                specialTag = true;
            }
            curTag = "";
        }
        if(typeof curTag === "string") {
            curTag += ch;
        }
        if(!specialTag && ch === ">" || specialTag && xml.slice(i - "]]>".length + 1, i + 1) === "]]>") {
            if(curTag === undefined) {
                throw new Error(`Ended tag, but tag was not opened, ${xml.slice(i, i + 100)}`);
            }
            tags.push(curTag);
            curTag = undefined;
            specialTag = false;
        }
    }
    if(curTag) {
        throw new Error(`Last tag not closed`);
    }
    return tags;
}

function parseAttName(text: string, index: { v: number }): string {
    let att = "";
    while(index.v < text.length && text[index.v] === ` `) {
        index.v++;
    }
    while(index.v < text.length && text[index.v] !== `=` && text[index.v] !== ` ` && text[index.v] !== `>` && text[index.v] !== `/`) {
        att += text[index.v++];
    }
    att = att.trim();
    if(att.length === 0 && text[index.v] === "/") {
        return "/";
    }
    if(att.endsWith("=")) {
        att = att.slice(0, -1);
    }
    return att.trim();
}

function parseAttValue(text: string, index: { v: number }): string {
    while(index.v < text.length && text[index.v] === ` `) {
        index.v++;
    }

    if(text[index.v] !== "=") {
        return true as any;
    }
    index.v++;

    while(index.v < text.length && text[index.v] === ` `) {
        index.v++;
    }

    let delimit = text[index.v];
    if(delimit !== `"` && delimit !== `'`) {
        throw new Error(`Unexpected value string character ${delimit}`);
    }
    index.v++;

    let value = "";
    while(index.v < text.length && text[index.v] !== delimit) {
        value += text[index.v++];
    }
    index.v++;

    return value;
}

function parseTagObj(tag: string): {
    rawTextOverride?: string;
    endChars: string,
    tagName: string;
    endSelf?: boolean;
    endParent?: boolean;
    properties: {
        [key: string]: string
    }
} {
    if(tag.startsWith("<![")) {
        return {
            endChars: "",
            tagName: "raw",
            endSelf: true,
            properties: { },
            rawTextOverride: tag,
        };
    }

    let endChars = "";
    let endSelf = false;
    let index = { v: 1 };

    let endParent = false;
    if(tag[index.v] === "/") {
        index.v++;
        endParent = true;
    }

    let tagName = parseAttName(tag, index);
    if(endParent) {
        return {
            endChars: "",
            tagName,
            endParent: true,
            properties: {},
        };
    }

    let properties: {
        [key: string]: string
    } = Object.create(null);

    while(index.v < tag.length) {
        let attName = parseAttName(tag, index);
        if(attName === "/") {
            endChars = "/";
            endSelf = true;
            break;
        }
        if(!attName) break;
        let value = parseAttValue(tag, index);
        properties[attName] = value;
    }

    if(tagName[0] === "?" || tagName[0] === "!") {
        endSelf = true;
    }

    return {
        tagName,
        endParent,
        endSelf,
        properties,
        endChars,
    };
}

//todonext
// Ah, okay, so... properties, and children, but also...
//  special properties by type, one for first, the other for an array, which have the same objects,
//  but just make accessing singletons, or arrays by type, easier. And children will still define the order,
//  but if anything is just in the special properties... we append it to the end of children.

function parseObject(
    parentObject: any,
    tags: string[],
    tagIndex: { v: number },
): any {
    let tag = tags[tagIndex.v++];

    let tagObj = parseTagObj(tag);

    if(tagObj.rawTextOverride) {
        parentObject[SPECIAL_PREFIX + "children"].push(tagObj.rawTextOverride);
        return;
    }
    if(tagObj.endParent) return true;

    let tagObject = Object.create(null);
    let tagName = tagObject[SPECIAL_PREFIX + "type"] = tagObj.tagName;

    // Properties
    Object.assign(tagObject, tagObj.properties);

    tagObject[SPECIAL_PREFIX + "endChars"] = tagObj.endChars;

    tagObject[SPECIAL_PREFIX + "children"] = [];

    if(!tagObj.endSelf) {
        while(tagIndex.v < tags.length) {
            if(parseObject(tagObject, tags, tagIndex)) {
                break;
            }
        }
    }

    tagObject[SPECIAL_PREFIX + "emitCount"] = 0;

    // First object (optional)
    if(!(tagName in parentObject)) {
        parentObject[tagName] = tagObject;
        tagObject[SPECIAL_PREFIX + "emitCount"]++;
    }

    // Array of type
    let arrayTagName = tagName + "s";
    // Add $ until we find a free name
    while(arrayTagName in parentObject && !Array.isArray(parentObject[arrayTagName])) {
        arrayTagName = "$" + arrayTagName;
    }
    parentObject[arrayTagName] = parentObject[arrayTagName] || [];
    parentObject[arrayTagName].push(tagObject);
    tagObject[SPECIAL_PREFIX + "emitCount"]++;

    parentObject[SPECIAL_PREFIX + "children"].push(tagObject);
    tagObject[SPECIAL_PREFIX + "emitCount"]++;

    if(tagObj.endSelf) {
        tagObject[SPECIAL_PREFIX + "endSelf"] = true as any;
    }
}

function parseXml(
    xml: string
): any {
    let tags = parseRawTags(xml);

    let tagIndex = { v: 0 };
    let rootObject = Object.create(null);
    rootObject[SPECIAL_PREFIX + "children"] = [];
    while(tagIndex.v < tags.length) {
        parseObject(rootObject, tags, tagIndex);
    }
    return rootObject;
}

// https://stackoverflow.com/questions/1091945/what-characters-do-i-need-to-escape-in-xml-documents
// TODO: We don't need to escape as much as we do, but... w/e
function escapeXML(value: string, type: "attributeSingle"|"attributeDouble") {
    if(type === "attributeSingle") {
        return (
            value
                .replace(/'/g, "&apos;")
                .replace(/</g, "&lt;")
                .replace(/&/g, "&amp;")
        );
    } else if(type === "attributeDouble") {
        return (
            value
                .replace(/"/g, "&quot;")
                .replace(/</g, "&lt;")
                .replace(/&/g, "&amp;")
        );
    }
    return (
        value
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&apos;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/&/g, "&amp;")
    );
}

function writeXml(obj: any, tagName: string|null = null, indent: string=""): string {
    if(typeof obj === "string") {
        return indent + obj + "\n";
    }

    let endChars = obj[SPECIAL_PREFIX + "endChars"];
    // We just infer the tag name from the attribute name, if it exists.
    //  Sometimes this is impossible though, such as for values that only exist in
    //  children.
    tagName = tagName || obj[SPECIAL_PREFIX + "type"];
    let children = obj[SPECIAL_PREFIX + "children"];
    let endSelf = obj[SPECIAL_PREFIX + "endSelf"];

    let output = "";

    // Properties
    let properties: string[] = [];
    for(let key in obj) {
        if(key.startsWith(SPECIAL_PREFIX)) continue;
        let value = obj[key];
        if(typeof value === "object") continue;
        if(value === true) {
            properties.push(`${key}`);
        } else {
            properties.push(`${key}="${escapeXML(value, "attributeDouble")}"`);
        }
    }

    if(!tagName && properties.length > 0) {
        throw new Error(`Unexpected properties in root object, ${properties}`);
    }

    if(tagName) {
        output += `${indent}<${tagName}${properties.map(x => " " + x).join("")}`;
        if(endChars) {
            output += endChars;
        }
        output += `>\n`;

        if(endSelf) {
            return output;
        }
    }

    let childIndent = tagName ? indent + "    " : indent;
    let childrenAdded: Map<unknown, number> = new Map();
    
    function addChild(child: any, tagName: string|null) {
        let emitCount = child[SPECIAL_PREFIX + "emitCount"] || 1;
        if(tagName) {
            childrenTagNames.set(child, tagName);
        } else {
            tagName = childrenTagNames.get(child) || null;
        }
        // Basically... if we add it 3 times (the first propery, the type array, and children),
        //  and they remove it from any place, we want to remove it. But if they added it, we should
        //  just add it (but only once). This also means the children array order is respected,
        //  so they can rearrange it in there.
        let count = (childrenAdded.get(child) || 0) + 1;
        childrenAdded.set(child, count);
        if(count !== emitCount) {
            return;
        }
        output += writeXml(child, tagName, childIndent);
    }
    let childrenTagNames: Map<unknown, string> = new Map();
    children = children || [];
    {
        for(let key in obj) {
            if(key.startsWith(SPECIAL_PREFIX)) continue;
            let value = obj[key];
            if(typeof value !== "object") continue;
            if(Array.isArray(value)) {
                let tagName = key;
                if(tagName.endsWith("s")) {
                    tagName = tagName.slice(0, -1);
                }
                for(let v of value) {
                    addChild(v, tagName);
                }
            } else {
                let tagName = key;
                addChild(value, tagName);
            }
        }
    }
    
    for(let child of children) {
        addChild(child, childrenTagNames.get(child) || null);
    }
    
    if(tagName) {
        output += `${indent}</${tagName}>\n`;
    }

    return output;
}


let input = require("os").homedir() + "/triplea/downloadedMaps/battle_for_arda-master";


let file = fs.readFileSync(input + ".zip");

(async () => {
    let contents = await zip.loadAsync(file)

    let xmlPath = Object.keys(contents.files).filter(x => x.endsWith("Battle_For_Arda.xml"))[0];
    let xmlText = await contents.files[xmlPath].async("text");

    let obj = parseXml(xmlText);
    {
        obj.game.info.name = "+ Middle Earth Without The Lag";

        let factionsToRemove: string[] = [
            "Mordor",
            "Gondor",
            "Rohan",
            "Saruman",
            "DolGuldur",
            "Rhun",
            "Northmen",
            "WoodlandRealm",
            //"Dwarves",
            "Harad",
        ];

        let territoriesToRemove: string[];

        territoriesToRemove = obj.game.initialize.ownerInitialize.territoryOwners
            .filter((x: any) => factionsToRemove.includes(x.owner))
            .map((x: any) => x.territory)
        ;

        territoriesToRemove = territoriesToRemove.concat([
            "Andrast",
            "Lower Lefnui",
            "Drúwaith Iaur",
            "Ras Morthil",
            "Upper Lefnui",
            "Isen South Bank",
            "West Ered Nimrais",
            "Lefnui Vale",
            "Ered Nimrais",
            "Nindalf",
            "Emyn Muil",
            "Dead Marshes",
            "South Undeep",
            "North Undeep",
            "West Brown Lands",
            "North Brown Lands",
            "The Undeeps",
            "East Brown Lands",
            "Dagorlad",
            "East Wilderland",
            "Drúadan Forest"
        ]);

        obj.game.playerList.players = obj.game.playerList.players.filter(
            (x: any) => !(factionsToRemove.includes(x.name))
        );
        obj.game.playerList.alliances = obj.game.playerList.alliances.filter(
            (x: any) => !(factionsToRemove.includes(x.player))
        );

        obj.game.gamePlay.sequence.steps = obj.game.gamePlay.sequence.steps.filter(
            (x: any) => !(factionsToRemove.includes(x.player))
        );

        obj.game.production.playerProductions = obj.game.production.playerProductions.filter(
            (x: any) => !(factionsToRemove.includes(x.player))
        );

        for(let attachment of obj.game.attachmentList.attachments) {
            let players = attachment.options.filter((x: any) => x.name === "players")[0];
            if(!players) continue;
            players.value = players.value.split(":").filter((x: any) => !(factionsToRemove.includes(x))).join(":");
        }
        let ffa = obj.game.attachmentList.attachments.filter((x: any) => x.name === "triggerAttachment_FFA")[0];
        ffa.options = ffa.options.filter((x: any) => 
            !(factionsToRemove.some(y => x.value.includes(y)))
        );

        for(let attachment of obj.game.attachmentList.attachments) {
            if(attachment.options.length !== 1) continue;
            attachment.options[0].value = attachment.options[0].value.split(":").filter((x: any) => !(territoriesToRemove.includes(x))).join(":");
        }

        let beforeCount = obj.game.map.territorys.length;
        obj.game.map.territorys = obj.game.map.territorys.filter(
            (x: any) => !(territoriesToRemove.includes(x.name))
        );
        let afterCount = obj.game.map.territorys.length;

        console.log(`${((1 - afterCount/beforeCount) * 100).toFixed(0)}% of territories removed`)

        obj.game.map.connections = obj.game.map.connections.filter(
            (x: any) => !(territoriesToRemove.includes(x.t1) || territoriesToRemove.includes(x.t2))
        );
        obj.game.attachmentList.attachments = obj.game.attachmentList.attachments.filter(
            (x: any) => !(territoriesToRemove.includes(x.attachTo))
        );
        obj.game.attachmentList.attachments = obj.game.attachmentList.attachments.filter(
            (x: any) => !(factionsToRemove.includes(x.attachTo))
        );
        obj.game.initialize.ownerInitialize.territoryOwners = obj.game.initialize.ownerInitialize.territoryOwners.filter(
            (x: any) => !(territoriesToRemove.includes(x.territory))
        );
        obj.game.initialize.unitInitialize.unitPlacements = obj.game.initialize.unitInitialize.unitPlacements.filter(
            (x: any) => !(territoriesToRemove.includes(x.territory) || factionsToRemove.includes(x.owner))
        );

        let seaUnitOption = obj.game.propertyList.propertys.filter((x: any) => x.name === "Sea Units")[0];
        seaUnitOption.value = "false";

        {
            let option = obj.game.propertyList.propertys.filter((x: any) => x.name === "Free For All")[0];
            option.value = "true";
        }

        obj.game.initialize.resourceInitialize.resourceGivens = obj.game.initialize.resourceInitialize.resourceGivens.filter(
            (x: any) => !(factionsToRemove.includes(x.player))
        );

        obj.game.attachmentList.attachments = obj.game.attachmentList.attachments.filter((x: any) => {
            let landTerritories = x.options.filter((x: any) => x.name === "landTerritories")[0];
            if(!landTerritories) return true;
            if(territoriesToRemove.some(y => landTerritories.value.includes(y))) {
                if(x.name.includes("FFA")) {
                    debugger;
                }
                return false;
            }
            return true;
        });

        for(let attachment of obj.game.attachmentList.attachments) {
            let when = attachment.options.filter((x: any) => x.name === "when")[0];
            if(!when) continue;
            if(when.value === "before:sarumanCombatMove") {
                when.value = "before:gameInitDelegate";
            }
        }

        // Reorder the steps to change the player order.
        let stepsHolder = obj.game.gamePlay.sequence;
        let steps = stepsHolder[SPECIAL_PREFIX + "children"];
        let initStep = steps[0];
        let lastStep = steps[steps.length - 1];
        let factionSteps = steps.splice(1, steps.length - 2);
        let stepsByFaction: { [faction: string]: any[] } = Object.create(null); 
        for(let factionStep of factionSteps) {
            stepsByFaction[factionStep.player] = stepsByFaction[factionStep.player] || [];
            stepsByFaction[factionStep.player].push(factionStep);
        }

        let factionOrder: string[] = [];

        let newFactionSteps: any[] = [];

        let priorityFactions: string[] = ["Angmar", "Orcs", "HighElves"];
        for(let faction of priorityFactions) {
            let factionSteps = stepsByFaction[faction];
            delete stepsByFaction[faction];
            for(let step of factionSteps) {
                if(!factionOrder.includes(step.player)) {
                    factionOrder.push(step.player);
                }
                newFactionSteps.push(step);
            }
        }
        for(let faction in stepsByFaction) {
            let factionSteps = stepsByFaction[faction];
            delete stepsByFaction[faction];
            for(let step of factionSteps) {
                if(!factionOrder.includes(step.player)) {
                    factionOrder.push(step.player);
                }
                newFactionSteps.push(step);
            }
        }

        steps.splice(1, 0, ...newFactionSteps);

        console.log(factionOrder);

        //console.log(stepsHolder);

        let v = (x: any) => x.player ? 10000 : factionOrder.indexOf(x.name);
        obj.game.playerList[SPECIAL_PREFIX + "children"].sort((a: any, b: any) =>
            v(a) - v(b)
        );

        // obj.game.playerList.players
    }

    xmlText = writeXml(obj);
    

    contents.file(xmlPath, xmlText);

    let outputBuffer = await contents.generateAsync({ type: "nodebuffer" });
    fs.writeFileSync(input + "-2.zip", outputBuffer as any);

})().catch(e => {throw e});