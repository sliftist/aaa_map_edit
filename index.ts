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

    // First object (optional)
    if(!(tagName in parentObject)) {
        parentObject[tagName] = tagObject;
    }

    // Array of type
    let arrayTagName = tagName + "s";
    // Add $ until we find a free name
    while(arrayTagName in parentObject && !Array.isArray(parentObject[arrayTagName])) {
        arrayTagName = "$" + arrayTagName;
    }
    parentObject[arrayTagName] = parentObject[arrayTagName] || [];
    parentObject[arrayTagName].push(tagObject);

    parentObject[SPECIAL_PREFIX + "children"].push(tagObject);

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
    let childrenAdded: Set<unknown> = new Set();
    function addChild(child: any, tagName: string|null) {
        if(childrenAdded.has(child)) return;
        childrenAdded.add(child);
        output += writeXml(child, tagName, childIndent);
    }
    let childrenTagNames: Map<unknown, string> = new Map();
    children = children || [];
    {
        let existingChildren = new Set(children);
        for(let key in obj) {
            if(key.startsWith(SPECIAL_PREFIX)) continue;
            let value = obj[key];
            if(typeof value !== "object") continue;
            function addChild(child: any, tagName: string) {
                childrenTagNames.set(child, tagName);
                if(existingChildren.has(child)) return;
                children.push(child);
            }
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

    obj.game.info.name = "+ Middle Earth Without The Lag";

    xmlText = writeXml(obj);
    

    contents.file(xmlPath, xmlText);

    let outputBuffer = await contents.generateAsync({ type: "nodebuffer" });
    fs.writeFileSync(input + "-2.zip", outputBuffer as any);


    //fs.copyFileSync(input + ".zip.properties", input + "-2.zip.properties");

    //console.log("test");

    //let obj = await xml2js.parseStringPromise(xmlText);

    //obj.game.info[0].$.name += " - Changed";

    //console.log(js2xmlparser.parse("game", obj));

    //console.log(obj);

    /*
    console.log("zip", file);

    let test = zlib.gzipSync(Buffer.from("test text", "utf8"));
    console.log("zip", test);
    console.log(zlib.unzipSync(test));
    */

    //let output = zlib.gunzipSync(new Uint8Array(file));
    //console.log(output.toString());


    //fs.copyFileSync(input + ".zip", input + "-2.zip");
    //fs.copyFileSync(input + ".zip.properties", input + "-2.zip.properties");
})().catch(e => {throw e});