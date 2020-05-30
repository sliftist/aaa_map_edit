import * as fs from "fs";
import * as zlib from "zlib";

import * as zip from "jszip";

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
        if(inComment && (xml.slice(i - "-->".length, i) === "-->")) {
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
                throw new Error(`Starting new tag with old tag still open ${xml.slice(i, i + 100)}`);
            }
            if(xml.slice(i, i + "<![".length) === "<![") {
                specialTag = true;
            }
            curTag = "";
        }
        if(typeof curTag === "string") {
            curTag += ch;
        }
        if(!specialTag && ch === ">" || specialTag && xml.slice(i - "]]>".length, i) === "]]>") {
            if(curTag === undefined) {
                throw new Error(`Ended tag, but not tag was open`);
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

const rawTextSymbol = Symbol("rawTextSymbol");

function parseTagObj(tag: string): {
    rawTextOverride?: string;
    startChars: string;
    tagName: string;
    endSelf?: boolean;
    endParent?: boolean;
    properties: {
        [key: string]: string
    }
} {
    if(tag.startsWith("<![")) {
        return {
            startChars: "",
            tagName: "raw",
            endSelf: true,
            properties: { },
            rawTextOverride: tag.slice(1, -1),
        };
    }

    let startChars = "";
    let endSelf = false;
    let index = { v: 1 };

    let endParent = false;
    if(tag[index.v] === "/") {
        index.v++;
        endParent = true;
    }

    if(tag[index.v] === "?" || tag[index.v] === "!") {
        startChars = tag[index.v];
        endSelf = true;
        index.v++;
    }

    let tagName = parseAttName(tag, index);
    if(endParent) {
        return {
            startChars: "",
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
            endSelf = true;
            break;
        }
        if(!attName) break;
        let value = parseAttValue(tag, index);
        properties[attName] = value;
    }

    return {
        startChars,
        tagName,
        endParent,
        endSelf,
        properties,
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
        parentObject.$$children.push(tagObj.rawTextOverride);
        return;
    }
    if(tagObj.endParent) return true;

    let tagObject = Object.create(null);
    let tagName = tagObject.$$type = tagObj.tagName;
    delete tagObj.properties[tagObject.$$type];

    Object.assign(tagObject, tagObj.properties);

    tagObject.$$startChar = tagObj.startChars;

    tagObject.$$children = [];

    if(!tagObj.endSelf) {
        while(tagIndex.v < tags.length) {
            if(parseObject(tagObject, tags, tagIndex)) {
                break;
            }
        }
    }

    // Arrays
    parentObject["$_" + tagName] = parentObject["$_" + tagName] || [];
    parentObject["$_" + tagName].push(tagObject);

    // First object
    parentObject["$" + tagName] = parentObject["$" + tagName] || tagObject;

    parentObject.$$children.push(tagObject);
}

function parseXml(
    xml: string
): any {
    let tags = parseRawTags(xml);

    let tagIndex = { v: 0 };
    let rootObject = Object.create(null);
    rootObject.$$children = [];
    while(tagIndex.v < tags.length) {
        parseObject(rootObject, tags, tagIndex);
    }
    //console.log(rootObject.$$children[2]);
    console.log(rootObject.$game.$map.$_territory[10]);

    //todonext;
    // Hmm... parsing seems to work, so... now go from object back into xml. And remember, children order decides the order, BUT,
    //  anything as $, or $_, that isn't in children, needs to be added too. Also, properties should be set too.
    //  ANd you know, remember $$startChar, $$type, etc.


    //console.log(tags);

    // Parse into tags, and contents of tags.
    //  - Parse each tag into attributes
    //  - Create objects
    //  - Etc...
    // Oh... xml has no tag contents? Huh... okay, that's easy...
}


let input = "C:/Users/quent/triplea/downloadedMaps/battle_for_arda-master";


let file = fs.readFileSync(input + ".zip");

(async () => {
    let contents = await zip.loadAsync(file)

    let xmlPath = Object.keys(contents.files).filter(x => x.endsWith("TAGX.xml"))[0];
    let xmlText = await contents.files[xmlPath].async("text");

    let obj = parseXml(xmlText);
    console.log();


    
    /*

    let obj = JSON.parse(parser.toJson(xmlText));
    obj.game.info.name += " - 2";
    
    let xml = parser.toXml(obj);

    contents.file(xmlPath, xml);

    let outputBuffer = await contents.generateAsync({ type: "nodebuffer" });
    fs.writeFileSync(input + "-2.zip", outputBuffer as any);
    */



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