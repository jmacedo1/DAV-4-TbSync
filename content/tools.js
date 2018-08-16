/*
 * This file is part of DAV-4-TbSync.
 *
 * TbSync is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * TbSync is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with DAV-4-TbSync. If not, see <https://www.gnu.org/licenses/>.
 */

"use strict";

dav.tools = {

    xmlns: function (ns) {
        let _xmlns = [];
        for (let i=0; i < ns.length; i++) {
            _xmlns.push('xmlns:'+ns[i]+'="'+dav.ns[ns[i]]+'"');
        }
        return _xmlns.join(" ");
    },

    parseUri: function (aUri) {
        let uri;
        try {
            // Test if the entered uri can be parsed.
            uri = Services.io.newURI(aUri, null, null);
        } catch (ex) {
            throw dav.sync.failed("invalid-carddav-uri");
        }

        let calManager = cal.getCalendarManager();
        let cals = calManager.getCalendars({});
        if (cals.some(calendar => calendar.uri.spec == uri.spec)) {
            throw dav.sync.failed("info.caldav-calendar-already-exists");
        }

        return uri;
    },
    
    hashMD5: function (str) {
        var converter = Components.classes["@mozilla.org/intl/scriptableunicodeconverter"].createInstance(Components.interfaces.nsIScriptableUnicodeConverter);

        // we use UTF-8 here, you can choose other encodings.
        converter.charset = "UTF-8";
        // result is an out parameter,
        // result.value will contain the array length
        var result = {};
        // data is an array of bytes
        var data = converter.convertToByteArray(str, result);
        var ch = Components.classes["@mozilla.org/security/hash;1"].createInstance(Components.interfaces.nsICryptoHash);
        ch.init(ch.MD5);
        ch.update(data, data.length);
        var hash = ch.finish(false);

        // return the two-digit hexadecimal code for a byte
        function toHexString(charCode)
        {
          return ("0" + charCode.toString(16)).slice(-2);
        }

        // convert the binary hash data to a hex string.
        var s = Array.from(hash, (c, i) => toHexString(hash.charCodeAt(i))).join("");
        // s now contains your hash in hex: should be
        // 5eb63bbbe01eeed093cb22bb8f5acdc3    
        return s;
    },
    
    /*
     * Part of digest-header - index.js : https://github.com/node-modules/digest-header
     *
     * Copyright(c) fengmk2 and other contributors.
     * MIT Licensed
     *
     * Authors:
     *   fengmk2 <fengmk2@gmail.com> (http://fengmk2.github.com)
     */
    getAuthOptions: function (str) {
        let parts = str.split(',');
        let opts = {};
        let AUTH_KEY_VALUE_RE = /(\w+)=["']?([^'"]+)["']?/;
        for (let i = 0; i < parts.length; i++) {
            let m = parts[i].match(AUTH_KEY_VALUE_RE);
            if (m) {
                opts[m[1]] = m[2].replace(/["']/g, '');
            }
        }
        return opts;
    },

    /*
     * Part of digest-header - index.js : https://github.com/node-modules/digest-header
     *
     * Copyright(c) fengmk2 and other contributors.
     * MIT Licensed
     *
     * Authors:
     *   fengmk2 <fengmk2@gmail.com> (http://fengmk2.github.com)
     */
    getDigestAuthHeader: function (method, uri, user, password, options, account) {
        let opts = dav.tools.getAuthOptions(options);
        if (!opts.realm || !opts.nonce) {
            return "";
        }
        let qop = opts.qop || "";
  
        let userpass = [user,password];

        let NC_PAD = '00000000';
        let nc = parseInt(tbSync.db.getAccountSetting(account, "authDigestNC"));
        tbSync.db.setAccountSetting(account, "authDigestNC", String(++nc))

        nc = NC_PAD.substring(nc.length) + nc;
  
        let randomarray = new Uint8Array(8);
        tbSync.window.crypto.getRandomValues(randomarray);
        let cnonce = randomarray.toString('hex');

        var ha1 = dav.tools.hashMD5(userpass[0] + ':' + opts.realm + ':' + userpass[1]);
        var ha2 = dav.tools.hashMD5(method.toUpperCase() + ':' + uri);
        var s = ha1 + ':' + opts.nonce;
        if (qop) {
            qop = qop.split(',')[0];
            s += ':' + nc + ':' + cnonce + ':' + qop;
        }
        s += ':' + ha2;
        
        var response = dav.tools.hashMD5(s);
        var authstring = 'Digest username="' + userpass[0] + '", realm="' + opts.realm + '", nonce="' + opts.nonce + '", uri="' + uri + '", response="' + response + '"';
        if (opts.opaque) {
            authstring += ', opaque="' + opts.opaque + '"';
        }
        if (qop) {
            authstring +=', qop=' + qop + ', nc=' + nc + ', cnonce="' + cnonce + '"';
        }
        return authstring;        
    },
    

    convertToXML: function(text) {
        //try to convert response body to xml
        let xml = null;
        let oParser = (Services.vc.compare(Services.appinfo.platformVersion, "61.*") >= 0) ? new DOMParser() : Components.classes["@mozilla.org/xmlextras/domparser;1"].createInstance(Components.interfaces.nsIDOMParser);
        try {
            xml = oParser.parseFromString(text, "application/xml");
        } catch (e) {
            //however, domparser does not throw an error, it returns an error document
            //https://developer.mozilla.org/de/docs/Web/API/DOMParser
            xml = null;
        }
        //check if xml is error document
        if (xml.documentElement.nodeName == "parsererror") {
            xml = null;
        }

        return xml;
    },
    
    sendRequest: Task.async (function* (request, _url, method, syncdata, headers) {
        let account = tbSync.db.getAccount(syncdata.account);
        let password = tbSync.getPassword(account);

        let url = "http" + (account.https ? "s" : "") + "://" + account.host + _url;
        //tbSync.dump("URL", url);

        let useAbortSignal = (Services.vc.compare(Services.appinfo.platformVersion, "57.*") >= 0);

        let options = {};
        options.method = method;
        options.body = request;
        options.cache = "no-cache";
        //do not include credentials, so we do not end up in a session, see https://github.com/owncloud/core/issues/27093
        options.credentials = "omit"; 
        options.redirect = "follow";// manual, *follow, error
        options.headers = headers;
        options.headers["Content-Length"] = request.length;
        options.headers["Content-Type"] = "application/xml; charset=utf-8";            

            
        //add abort/timeout signal
        let controller = null;
        if (useAbortSignal) {
            controller = new  tbSync.window.AbortController();
            options.signal = controller.signal;
        }
        
        let numberOfAuthLoops = 0;
        do {
            numberOfAuthLoops++;
            
            switch(tbSync.db.getAccountSetting(syncdata.account, "authMethod")) {
                case "":
                    //not set yet, send unauthenticated request
                    break;
                
                case "Basic":
                    options.headers["Authorization"] = "Basic " + btoa(account.user + ':' + password);
                    break;

                case "Digest":
                    //try to re-use the known server nounce (stored in account.authOptions)
                    options.headers["Authorization"] = dav.tools.getDigestAuthHeader(method, _url, account.user, password, account.authOptions, syncdata.account);
                    break;
            
                default:
                    throw dav.sync.failed("unsupported_auth_method:" + account.authMethod);
            }

            //try to fetch
            let response = null;
            let timeoutId = null;
            try {
                if (useAbortSignal) timeoutId = tbSync.window.setTimeout(() => controller.abort(), tbSync.prefSettings.getIntPref("timeout"));
                response = yield tbSync.window.fetch(url, options);
                if (useAbortSignal) tbSync.window.clearTimeout(timeoutId);
            } catch (e) {
                //fetch throws on network errors or timeout errors
                if (useAbortSignal && e instanceof AbortError) {
                    throw dav.sync.failed("timeout");
                } else {
                    throw dav.sync.failed("networkerror");
                }        
            }

            //TODO: Handle cert errors ??? formaly done by
            //let error = tbSync.createTCPErrorFromFailedXHR(syncdata.req);

            let text = yield response.text();            
            tbSync.dump("RESPONSE", response.status + " : " + text);
            switch(response.status) {
                case 401: // AuthError
                    {
                        let authHeader = response.headers.get("WWW-Authenticate")
                        //update authMethod and authOptions    
                        if (authHeader) {
                            let m = null;
                            let o = null;
                            [m, o] = authHeader.split(/ (.*)/);
                            //tbSync.dump("AUTH_HEADER_METHOD", m);
                            //tbSync.dump("AUTH_HEADER_OPTIONS", o);

                            //check if nonce changed, if so, reset nc
                            let opt_old = dav.tools.getAuthOptions(tbSync.db.getAccountSetting(syncdata.account, "authOptions"));
                            let opt_new = dav.tools.getAuthOptions(o);
                            if (opt_old.nonce != opt_new.nonce) {
                                tbSync.db.setAccountSetting(syncdata.account, "authDigestNC", "0");
                            }
                            
                            tbSync.db.setAccountSetting(syncdata.account, "authMethod", m);
                            tbSync.db.setAccountSetting(syncdata.account, "authOptions", o);
                            //is this the first fail? Retry with new settings.
                            if (numberOfAuthLoops == 1) continue;
                        }
                        throw dav.sync.failed("401");
                    }
                    break;
        
                case 207: //preprocess multiresponse
                    {
                        let xml = dav.tools.convertToXML(text);
                        if (xml === null) throw dav.sync.failed("mailformed-xml");
                        
                        let response = {};
                        response.node = xml.documentElement;

                        let multi = xml.documentElement.getElementsByTagNameNS(dav.ns.d, "response");
                        response.multi = [];
                        for (let i=0; i < multi.length; i++) {
                            let statusNode = dav.tools.evaluateNode(multi[i], [["d","propstat"], ["d", "status"]]);
                            let hrefNode = dav.tools.evaluateNode(multi[i], [["d","href"]]);

                            let resp = {};
                            resp.node = multi[i];
                            resp.status = statusNode === null ? null : statusNode.textContent.split(" ")[1];
                            resp.href = hrefNode === null ? null : hrefNode.textContent;
                            response.multi.push(resp);
                        }
            
                        return response;
                    }
                    break;
                    
                case 204: //is returned by DELETE - no data
                case 201: //is returned by CREATE - no data
                    return null;
                    break;

                case 403:
                case 404:
                    {
                        let xml = dav.tools.convertToXML(text);
                        if (xml !== null) {
                            let exceptionNode = dav.tools.evaluateNode(xml.documentElement, [["s","exception"]]);
                            if (exceptionNode !== null) {
                                let response = {};
                                response.exception = exceptionNode.textContent;
                                return response;
                            }
                        }
                    }
                                  
                default:
                    throw dav.sync.failed(response.status);
                    
            }
        }
        while (true);
    }),
    
    
    evaluateNode: function (_node, path) {
        let node = _node;
        let valid = false;
        
        for (let i=0; i < path.length; i++) {

            let children = node.children;
            valid = false;
            
            for (let c=0; c < children.length; c++) {
                if (children[c].localName == path[i][1] && children[c].namespaceURI == dav.ns[path[i][0]]) {
                    node = children[c];
                    valid = true;
                    break;
                }
            }

            if (!valid) {
                //none of the children matched the path abort
                return null;
            }
        }

        if (valid) return node;
        return null;
    },

    getNodeTextContentFromMultiResponse: function (response, path, href = null, status = "200") {
        for (let i=0; i < response.multi.length; i++) {
            let node = dav.tools.evaluateNode(response.multi[i].node, path);
            if (node !== null && (href === null || response.multi[i].href == href) && response.multi[i].status == status) 
                return node.textContent;
        }
        return null;
    },
    
    getMultiGetRequest: function(hrefs) {
        let request = "<card:addressbook-multiget "+dav.tools.xmlns(["d", "card"])+"><d:prop><d:getetag /><card:address-data /></d:prop>";
        let counts = 0;
        for (let i=0; i < hrefs.length; i++) {
            request += "<d:href>"+hrefs[i]+"</d:href>";
            counts++;
        }
        request += "</card:addressbook-multiget>";

        if (counts > 0) return request;
        else return null;
    },
    




    deleteContacts: function(addressBook, vCardsDeletedOnServer, syncdata) {
        if (vCardsDeletedOnServer.length > 0) {
            syncdata.todo = vCardsDeletedOnServer.length;
            syncdata.done = 0;
            tbSync.setSyncState("eval.response.remotechanges", syncdata.account, syncdata.folderID);
            addressBook.deleteCards(vCardsDeletedOnServer);           
        }
    },
    
    addContact: function(addressBook, id, data, etag, syncdata) {        
        //prepare new card
        let card = Components.classes["@mozilla.org/addressbook/cardproperty;1"].createInstance(Components.interfaces.nsIAbCard);
        card.setProperty("TBSYNCID", id);

        dav.tools.setThunderbirdCardFromVCard(addressBook, card, data.textContent.trim(), etag.textContent);
        
        tbSync.db.addItemToChangeLog(syncdata.targetId, id, "added_by_server");
        addressBook.addCard(card);
    },
    
    modifyContact: function(addressBook, id, data, etag, syncdata) {
        let card = addressBook.getCardFromProperty("TBSYNCID", id, true);                    

        dav.tools.setThunderbirdCardFromVCard(addressBook, card, data.textContent.trim(), etag.textContent, card.getProperty("X-DAV-VCARD", ""));        

        if (tbSync.db.getItemStatusFromChangeLog(syncdata.targetId, id) != "modified_by_user") {
            tbSync.db.addItemToChangeLog(syncdata.targetId, id, "modified_by_server");
        }
        addressBook.modifyCard(card);
    },










    //* * * * * * * * * * * * * * * * *
    //* ACTUAL SYNC MAGIC *
    //* * * * * * * * * * * * * * * * *
    
    //helper function: check vCardData object if it has a meta.type associated
    itemHasMetaType: function (vCardData, item, entry, typefield) {
        return (vCardData[item][entry].meta && 
                vCardData[item][entry].meta[typefield] && 
                vCardData[item][entry].meta[typefield].length > 0);
    },
    
    //helper function: for each entry for the given item, extract the associated meta.type
    getMetaTypeData: function (vCardData, item, typefield) {
        let metaTypeData = [];
        for (let i=0; i < vCardData[item].length; i++) {
            if (dav.tools.itemHasMetaType(vCardData, item, i, typefield)) {
                //bug in vCard parser? type is always array of length 1, all values joined by ,
                metaTypeData.push( vCardData[item][i].meta[typefield][0].split(",").map(function(x){ return x.toUpperCase().trim() }) );
            } else {
                metaTypeData.push([]);                
            }
        }
        return metaTypeData;
    },

    supportedProperties: [
        "DisplayName", 
        "FirstName",
        "LastName",
        "PrimaryEmail", 
        "SecondEmail",
        "NickName",
        "Birthday", //fake, will trigger special handling 
    
        "HomeCity",
        "HomeCountry",
        "HomeZipCode",
        "HomeState",
        "HomeAddress",
        "HomePhone",
        "WorkCity",
        "WorkCountry",
        "WorkZipCode",
        "WorkState",
        "WorkAddress",
        "WorkPhone",
    
        "Categories",
        "JobTitle",
        "Department",
        "Company",
        
        "WebPage1",
        "WebPage2",
        "CellularNumber",
        "PagerNumber",
        "FaxNumber",
        "Notes",

        "PreferMailFormat",
        "Custom1",
        "Custom2",
        "Custom3",
        "Custom4",
        
        "_GoogleTalk",
        "_JabberId",
        "_Yahoo",
        "_QQ",
        "_AimScreenName",
        "_MSN",
        "_Skype",
        "_ICQ",
        "_IRC",
                
/*        
        Foto
*/
    ],

    //map thunderbird fields to simple vcard fields without additional types
    simpleMap : {
        "Birthday" : "bday", //fake
        "JobTitle" : "title",
        "Department" : "org",
        "Company" : "org",
        "DisplayName" : "fn",
        "NickName" : "nickname",
        "Categories" : "categories",
        "Notes" : "note",
        "FirstName" : "n",
        "LastName" : "n",
        "PreferMailFormat" : "X-MOZILLA-HTML",
        "Custom1" : "X-MOZILLA-CUSTOM1",
        "Custom2" : "X-MOZILLA-CUSTOM2",
        "Custom3" : "X-MOZILLA-CUSTOM3",
        "Custom4" : "X-MOZILLA-CUSTOM4",
    },
        
    //map thunderbird fields to vcard fields with additional types
    complexMap : {
        "WebPage1" : {item: "url", type: "WORK"},
        "WebPage2" : {item: "url", type: "HOME"},
        "CellularNumber" : {item: "tel", type: "CELL"},
        "PagerNumber" : {item: "tel", type: "PAGER"},
        "FaxNumber" : {item: "tel", type: "FAX"},

        "HomeCity" : {item: "adr", type: "HOME"},
        "HomeCountry" : {item: "adr", type: "HOME"},
        "HomeZipCode" : {item: "adr", type: "HOME"},
        "HomeState" : {item: "adr", type: "HOME"},
        "HomeAddress" : {item: "adr", type: "HOME"},
        "HomePhone" : {item: "tel", type: "HOME"},

        "WorkCity" : {item: "adr", type: "WORK"},
        "WorkCountry" : {item: "adr", type: "WORK"},
        "WorkZipCode" : {item: "adr", type: "WORK"},
        "WorkState" : {item: "adr", type: "WORK"},
        "WorkAddress" : {item: "adr", type: "WORK"},
        "WorkPhone" : {item: "tel", type: "WORK"},
    },

    //map thunderbird fields to impp vcard fields with additional x-service-types
    imppMap : {
        "_GoogleTalk" : {item: "impp" , prefix: "xmpp:", type: "GOOGLETALK"}, //actually x-service-type
        "_JabberId" : {item: "impp", prefix: "xmpp:", type: "JABBER"},
        "_Yahoo" : {item: "impp", prefix: "ymsgr:", type: "YAHOO"},
        "_QQ" : {item: "impp", prefix: "x-apple:", type: "QQ"},
        "_AimScreenName" : {item: "impp", prefix: "aim:", type: "AIM"},
        "_MSN" : {item: "impp", prefix: "msn:", type: "MSN"},
        "_Skype" : {item: "impp", prefix: "skype:", type: "SKYPE"},
        "_ICQ" : {item: "impp", prefix: "icq:", type: "ICQ"},
        "_IRC" : {item: "impp", prefix: "irc:", type: "IRC"},
    },





    //For a given Thunderbird property, identify the vCard field
    // -> which main item
    // -> which array element (based on metatype, if needed)
    //https://tools.ietf.org/html/rfc2426#section-3.6.1
    getVCardField: function (property, vCardData) {
        let data = {item: "", metatype: [], metatypefield: "type", entry: -1, prefix: ""};
        
        if (vCardData) {
            //handle special cases independently, those from *Map will be handled by default
            switch (property) {
                case "PrimaryEmail": 
                case "SecondEmail": 
                    {
                        let metamap = {"PrimaryEmail": "WORK", "SecondEmail": "HOME"};
                        data.metatype.push(metamap[property]);
                        data.item = "email";

                        //search the first valid entry
                        if (vCardData[data.item]) {
                            let metaTypeData = dav.tools.getMetaTypeData(vCardData, data.item, data.metatypefield);

                            //check metaTypeData to find correct entry
                            if (property == "PrimaryEmail") {

                                let prev = [];
                                let work =[]; 
                                let workprev = [];
                                let nothome = [];
                                for (let i=0; i < metaTypeData.length; i++) {
                                    if (metaTypeData[i].includes("WORK") && metaTypeData[i].includes("PREV")) workprev.push(i);
                                    if (metaTypeData[i].includes("PREV") && !metaTypeData[i].includes("HOME")) prev.push(i);
                                    if (metaTypeData[i].includes("WORK")) work.push(i);
                                    if (!metaTypeData[i].includes("HOME")) nothome.push(i);
                                }
                                if (workprev.length > 0) data.entry = workprev[0];
                                else if (prev.length > 0) data.entry = prev[0];
                                else if (work.length > 0) data.entry = work[0];
                                else if (nothome.length > 0) data.entry = nothome[0];

                            } else {
                                
                                let homeprev = [];
                                let home = [];
                                for (let i=0; i < metaTypeData.length; i++) {
                                    if (metaTypeData[i].includes("HOME") && metaTypeData[i].includes("PREV")) homeprev.push(i);
                                    if (metaTypeData[i].includes("HOME")) home.push(i);
                                }
                                if (homeprev.length > 0) data.entry = homeprev[0];
                                else if (home.length > 0) data.entry = home[0];

                            }
                        }                        
                    }
                    break;

                default:
                    //Check *Maps
                    if (dav.tools.simpleMap.hasOwnProperty(property)) {

                        data.item = dav.tools.simpleMap[property];
                        if (vCardData[data.item] && vCardData[data.item].length > 0) data.entry = 0;

                    } else if (dav.tools.imppMap.hasOwnProperty(property)) {
                        
                        let type = dav.tools.imppMap[property].type;
                        data.metatype.push(type);
                        data.item = dav.tools.imppMap[property].item;
                        data.prefix = dav.tools.imppMap[property].prefix;
                        data.metatypefield = "x-service-type";
                        
                        if (vCardData[data.item]) {
                            let metaTypeData = dav.tools.getMetaTypeData(vCardData, data.item, data.metatypefield);
                            
                            let valids = [];
                            for (let i=0; i < metaTypeData.length; i++) {
                                if (metaTypeData[i].includes(type)) valids.push(i);
                            }
                            if (valids.length > 0) data.entry = valids[0];                            
                        }
                        
                    } else if (dav.tools.complexMap.hasOwnProperty(property)) {

                        let type = dav.tools.complexMap[property].type;
                        data.metatype.push(type);
                        data.item = dav.tools.complexMap[property].item;
                        
                        if (vCardData[data.item]) {
                            let metaTypeData = dav.tools.getMetaTypeData(vCardData, data.item, data.metatypefield);
                            let valids = [];
                            for (let i=0; i < metaTypeData.length; i++) {
                                if (metaTypeData[i].includes(type)) valids.push(i);
                            }
                            if (valids.length > 0) data.entry = valids[0];                            
                        }

                    } else throw "Unknown TB property <"+property+">";
            }
        }
        
        return data;
    },        





    //turn the given vCardValue into a string to be stored as a Thunderbird property
    getThunderbirdPropertyValueFromVCard: function (property, vCardData, vCardField) {
        let vCardValue = (vCardData && 
                                    vCardField && 
                                    vCardField.entry != -1 && 
                                    vCardData[vCardField.item] && 
                                    vCardData[vCardField.item][vCardField.entry]  && 
                                    vCardData[vCardField.item][vCardField.entry].value) ? vCardData[vCardField.item][vCardField.entry].value : null;
        
        if (vCardValue === null) {
            return null;
        }

        //handle all special fields, which are not plain strings
        switch (property) {
            case "HomeCity":
            case "HomeCountry":
            case "HomeZipCode":
            case "HomeState":
            case "HomeAddress":
            case "WorkCity":
            case "WorkCountry":
            case "WorkZipCode":
            case "WorkState":
            case "WorkAddress":
                {
                    let field = property.substring(4);
                    let index = ["OfficeBox","ExtAddr","Address","City","Country","ZipCode", "State"].indexOf(field);
                    return vCardValue[index];
                }
                break;

            case "FirstName":
            case "LastName":
                {
                    let index = ["LastName","FirstName","MiddleName","Prefix","Suffix"].indexOf(property);
                    return vCardValue[index];
                }
                break;
                
            case "Department":
            case "Company":
                {
                    let index = ["Company","Department"].indexOf(property);
                    if (vCardValue.length > index) return vCardValue[index];
                    //either not an array or field does not exist -> fallback for Company, return value
                    return "";
                }
                break;

            case "Categories": 
                return (Array.isArray(vCardValue) ? vCardValue.join("\u001A") : vCardValue);
                break;

            case "PreferMailFormat":
                if (vCardValue.toLowerCase() == "true") return 2;
                if (vCardValue.toLowerCase() == "false") return 1;
                return 0;
                break;
                
            default: //should be a single string
                let v = (Array.isArray(vCardValue)) ? vCardValue.join(" ") : vCardValue;
                if (vCardField.prefix.length > 0 && v.startsWith(vCardField.prefix)) return v.substring(vCardField.prefix.length);
                else return v;
        }
    },





    //add/update the given Thunderbird propeties value in vCardData obj
    updateValueOfVCard: function (property, vCardData, vCardField, value) {
        let add = false;
        let store = value ? true : false;
        let remove = (!store && vCardData[vCardField.item] && vCardField.entry != -1);
        
        //preperations if this item does not exist
        if (store && vCardField.entry == -1) {
            //entry does not exists, does the item exists?
            if (!vCardData[vCardField.item]) vCardData[vCardField.item] = [];
            let newItem = {};
            if (vCardField.metatype.length > 0) {
                newItem["meta"] = {};
                newItem["meta"][vCardField.metatypefield] = vCardField.metatype;
            }
            vCardField.entry = vCardData[vCardField.item].push(newItem) - 1;
            add = true;
        }

        //handle all special fields, which are not plain strings
        switch (property) {
            case "HomeCity":
            case "HomeCountry":
            case "HomeZipCode":
            case "HomeState":
            case "HomeAddress":
            case "WorkCity":
            case "WorkCountry":
            case "WorkZipCode":
            case "WorkState":
            case "WorkAddress":
                {
                    let field = property.substring(4);
                    let index = ["OfficeBox","ExtAddr","Address","City","Country","ZipCode", "State"].indexOf(field);
                    if (store) {
                        if (add) vCardData[vCardField.item][vCardField.entry].value = ["","","","","","",""];
                        while (vCardData[vCardField.item][vCardField.entry].value.length < index) vCardData[vCardField.item][vCardField.entry].value.push("");                        
                        vCardData[vCardField.item][vCardField.entry].value[index] = value;
                    } else if (remove) {
                        vCardData[vCardField.item][vCardField.entry].value[index] = "";  //Will be completly removed by the parser, if all fields are empty!                      
                    }
                }
                break;
                
            case "FirstName":
            case "LastName":
                {
                    let index = ["LastName","FirstName","MiddleName","Prefix","Suffix"].indexOf(property);
                    if (store) {
                        if (add) vCardData[vCardField.item][vCardField.entry].value = ["","","","",""];
                        while (vCardData[vCardField.item][vCardField.entry].value.length < index) vCardData[vCardField.item][vCardField.entry].value.push("");                                                
                        vCardData[vCardField.item][vCardField.entry].value[index] = value;
                    } else if (remove) {
                        vCardData[vCardField.item][vCardField.entry].value[index] = "";  //Will be completly removed by the parser, if all fields are empty!                      
                    }
                }
                break;

            case "Department":
            case "Company":
                {
                    let index = ["Company","Department"].indexOf(property);
                    if (store) {
                        if (add) vCardData[vCardField.item][vCardField.entry].value = ["",""];
                        while (vCardData[vCardField.item][vCardField.entry].value.length < index) vCardData[vCardField.item][vCardField.entry].value.push("");                        
                        vCardData[vCardField.item][vCardField.entry].value[index] = value;
                    } else if (remove && vCardData[vCardField.item][vCardField.entry].value.length > index) {
                        vCardData[vCardField.item][vCardField.entry].value[index] = "";  //Will be completly removed by the parser, if all fields are empty!                      
                    }
                }
                break;

            case "Categories": 
                if (store) vCardData[vCardField.item][vCardField.entry].value = value.split("\u001A");
                else if (remove) vCardData[vCardField.item][vCardField.entry].value = [];
                break;

            case "PreferMailFormat":
                {
                    if (store) {
                        let v = (value == 2) ? "TRUE" : (value == 1) ? "FALSE" : "";
                        vCardData[vCardField.item][vCardField.entry].value = v;
                    } else if (remove) vCardData[vCardField.item][vCardField.entry].value = "";
                }
                break;

            default: //should be a string
                if (store) vCardData[vCardField.item][vCardField.entry].value = vCardField.prefix + value;
                else if (remove) vCardData[vCardField.item][vCardField.entry].value = "";
        }        
    },




    //MAIN FUNCTIONS FOR UP/DOWN SYNC
    
    //update send from server to client
    setThunderbirdCardFromVCard: function(addressBook, card, vCard, etag, oCard = null) {
        let vCardData = tbSync.dav.vCard.parse(vCard);
        let oCardData = oCard ? tbSync.dav.vCard.parse(oCard) : null;

        tbSync.dump("JSON from vCard", JSON.stringify(vCardData));
        //if (oCardData) tbSync.dump("JSON from oCard", JSON.stringify(oCardData));

        card.setProperty("X-DAV-ETAG", etag);
        card.setProperty("X-DAV-VCARD", vCard);
        
        for (let f=0; f < dav.tools.supportedProperties.length; f++) {

            let property = dav.tools.supportedProperties[f];

            let vCardField = dav.tools.getVCardField(property, vCardData);
            let newServerValue = dav.tools.getThunderbirdPropertyValueFromVCard(property, vCardData, vCardField);

            let oCardField = dav.tools.getVCardField(property, oCardData);            
            let oldServerValue = dav.tools.getThunderbirdPropertyValueFromVCard(property, oCardData, oCardField);

            //smart merge: only update the property, if it has changed on the server (keep local modifications)
            if (newServerValue !== oldServerValue) {
                //some "properties" need special handling
                switch (property) {
                    case "Birthday":
                        {
                            if (newServerValue) {
                                //set
                                let bday = newServerValue.split("-");
                                card.setProperty("BirthYear", bday[0]);
                                card.setProperty("BirthMonth", bday[1]);
                                card.setProperty("BirthDay", bday[2]);
                            } else {
                                //clear (del if possible)
                                card.deleteProperty("BirthYear");
                                card.deleteProperty("BirthMonth");
                                card.deleteProperty("BirthDay");
                            }
                        }
                        break;
                    
                    default:
                        {
                            if (newServerValue) {
                                //set
                                card.setProperty(property, newServerValue);
                            } else {
                                //clear (del if possible)
                                card.setProperty(property, "");
                                try {
                                    card.deleteProperty(property);
                                } catch (e) {}
                            }
                        }
                        break;
                 }
            }
        }
        
        //Take care of Photo
        //tbSync.addphoto(id + '.jpg', item.card, xmltools.nodeAsArray(data.Picture)[0]); //Kerio sends Picture as container
        //if (card.getProperty("PhotoType", "") == "file") {
        //    wbxml.atag("Picture", tbSync.getphoto(item.card));                    
        //}
    },
    
    //return the stored vcard of the card (or empty vcard if none stored) and merge local changes
    getVCardFromThunderbirdCard: function(addressBook, id, generateUID = false) {        
        let card = addressBook.getCardFromProperty("TBSYNCID", id, true);                    
        let vCardData = tbSync.dav.vCard.parse(card.getProperty("X-DAV-VCARD", ""));
        
        if (generateUID) {
            let uuid = new dav.UUID();
            //the UID of the vCard is never used by TbSync, it differs from the href of this card (following the specs)
            vCardData["uid"] = [{"value": uuid.toString()}];
        }

        for (let f=0; f < dav.tools.supportedProperties.length; f++) {
            let property = dav.tools.supportedProperties[f];
            let vCardField = dav.tools.getVCardField(property, vCardData);

            //some "properties" need special handling
            switch (property) {
                case "Birthday":
                    {
                        let birthYear = parseInt(card.getProperty("BirthYear", 0));
                        let birthMonth = parseInt(card.getProperty("BirthMonth", 0));
                        let birthDay = parseInt(card.getProperty("BirthDay", 0));

                        let value = "";
                        if (birthYear && birthMonth && birthDay) {
                            value = birthYear + "-" + (birthMonth < 10 ? "0" : "") + birthMonth + "-" + (birthDay < 10 ? "0" : "") + birthDay;
                        }
                        dav.tools.updateValueOfVCard(property, vCardData, vCardField, value);
                    }
                    break;
                    
                default:
                    {
                        let value = card.getProperty(property, "");
                        dav.tools.updateValueOfVCard(property, vCardData, vCardField, value);
                    }
                    break;
            }
        }    
        
        return tbSync.dav.vCard.generate(vCardData).trim();
    },
        
}
