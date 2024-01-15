import type {CustomTagRendererRecord, CustomTextualRenderer} from 'react-native-render-html';
import AnchorRenderer from './AnchorRenderer';
import CodeRenderer from './CodeRenderer';
import EditedRenderer from './EditedRenderer';
import ImageRenderer from './ImageRenderer';
import MentionHereRenderer from './MentionHereRenderer';
import MentionUserRenderer from './MentionUserRenderer';
import NextStepEmailRenderer from './NextStepEmailRenderer';
import PreRenderer from './PreRenderer';

/**
 * This collection defines our custom renderers. It is a mapping from HTML tag type to the corresponding component.
 */
const HTMLEngineProviderComponentList: CustomTagRendererRecord = {
    // Standard HTML tag renderers
    a: AnchorRenderer,
    code: CodeRenderer as CustomTextualRenderer,
    img: ImageRenderer,
    video: AnchorRenderer, // temporary until we have a video player component

    // Custom tag renderers
    edited: EditedRenderer,
    pre: PreRenderer,
    /* eslint-disable @typescript-eslint/naming-convention */
    'mention-user': MentionUserRenderer as CustomTextualRenderer,
    'mention-here': MentionHereRenderer as CustomTextualRenderer,
    'next-step-email': NextStepEmailRenderer as CustomTextualRenderer,
    /* eslint-enable @typescript-eslint/naming-convention */
};

export default HTMLEngineProviderComponentList;
